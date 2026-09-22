import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { createFacesHandler } from '../src/core/faces/handler.js';
import { createHandler } from '../src/core/arocapi/handler.js';
import { ensureFacesSchema, addReferenceFace, listDetections, listReferenceFaces, isBackfillFullyChecked } from '../src/core/faces/store.js';
import {
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  setEntityFacetValues,
  crateEntityId,
  imageEntityId,
  personEntityId,
  listFacetValuesForEntity,
  getFileById,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
} from '../src/core/db/store.js';
import { loadOrCreateCrate, serializeCrate, addImageEntity, readImageRecord, CRATE_FILE_NAME } from '../src/core/crateBuilder.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

vi.mock('../src/core/exif.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, extractExif: vi.fn() };
});
// vi.mock calls are hoisted above imports by vitest, so this import
// binds to the mocked extractExif configured above.
import { extractExif } from '../src/core/exif.js';

let currentRoot = null;
let mainStore;
let facesStore;
let fsAdapter;
let handleRequest;
let writeFaceRegion;
const subCrateId = crateEntityId('2025');
const photoId = imageEntityId('2025', 'photo.jpg');
const taggedId = imageEntityId('2025', 'tagged.jpg');
const orientedId = imageEntityId('2025', 'oriented.jpg');

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
  vi.clearAllMocks();
});

beforeEach(async () => {
  const subCrate = loadOrCreateCrate(null);
  subCrate.rootDataset.name = '2025';
  addImageEntity(subCrate, { path: 'photo.jpg', exif: null, thumbnailPath: null, sourceModifiedAt: Date.now() });
  addImageEntity(subCrate, {
    path: 'tagged.jpg',
    exif: { Regions: { RegionList: [{ Name: 'Alice', Type: 'Face', Area: { x: 0.5, y: 0.4, w: 0.2, h: 0.15 } }] } },
    thumbnailPath: null,
    sourceModifiedAt: Date.now(),
  });
  // Real values from an actual Apple Photos-tagged file (see
  // Spec.md's Face Recognition section): its Area is measured against
  // the already-oriented display frame, not the raw frame — applying
  // the (otherwise correct) orientation correction to it lands nowhere
  // near a real face-api.js detection of the same face.
  addImageEntity(subCrate, {
    path: 'oriented.jpg',
    exif: {
      Orientation: 'Rotate 90 CW',
      Regions: { RegionList: [{ Name: 'John', Type: 'Face', Area: { x: 0.4411362806955973, y: 0.32195010781288147, w: 0.15869951248168945, h: 0.16543585062026978 } }] },
    },
    thumbnailPath: null,
    sourceModifiedAt: Date.now(),
  });

  currentRoot = await createFixtureTree({
    'ro-crate-metadata.json': serializeCrate(loadOrCreateCrate(null)),
    2025: {
      'ro-crate-metadata.json': serializeCrate(subCrate),
      'photo.jpg': 'fake jpeg bytes',
      'tagged.jpg': 'fake jpeg bytes',
      'oriented.jpg': 'fake jpeg bytes',
    },
  });

  fsAdapter = createNodeFsAdapter(currentRoot);
  mainStore = openNodeSqlite(':memory:');
  ensureSchema(mainStore);
  facesStore = openNodeSqlite(':memory:');
  ensureFacesSchema(facesStore);

  upsertRoCrate(mainStore, { id: subCrateId, path: '2025', name: '2025' });
  upsertEntity(mainStore, { id: subCrateId, roCrateId: subCrateId, entityType: ENTITY_TYPE_COLLECTION, name: '2025' });
  upsertEntity(mainStore, { id: photoId, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg', memberOf: subCrateId, title: 'photo.jpg' });
  upsertFile(mainStore, { id: photoId, entityId: photoId, filename: 'photo.jpg', mediaType: 'image/jpeg', size: 16, relativePath: photoId });
  upsertEntity(mainStore, { id: taggedId, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'tagged.jpg', memberOf: subCrateId, title: 'tagged.jpg' });
  upsertFile(mainStore, { id: taggedId, entityId: taggedId, filename: 'tagged.jpg', mediaType: 'image/jpeg', size: 16, relativePath: taggedId });
  upsertEntity(mainStore, { id: orientedId, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'oriented.jpg', memberOf: subCrateId, title: 'oriented.jpg' });
  upsertFile(mainStore, { id: orientedId, entityId: orientedId, filename: 'oriented.jpg', mediaType: 'image/jpeg', size: 16, relativePath: orientedId });

  writeFaceRegion = vi.fn().mockResolvedValue(undefined);
  handleRequest = createFacesHandler({ mainStore, facesStore, fsAdapter, writeFaceRegion });
});

describe('POST /scan-status', () => {
  it('reports an unscanned image as needing a scan', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/scan-status',
      body: { imageIds: [photoId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.toScan).toEqual([photoId]);
    expect(parsed.scanned).toEqual([]);
  });

  it('rejects a request missing model info', async () => {
    const res = await handleRequest({ method: 'POST', path: '/scan-status', body: { imageIds: [photoId] } });
    expect(res.status).toEqual(400);
  });
});

describe('POST /existing-regions and /backfill-reference', () => {
  it('lists an already-tagged region with no reference embedding yet', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/existing-regions',
      body: { imageIds: [photoId, taggedId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    const { regions } = JSON.parse(res.body);
    // No Orientation on this fixture, so raw and corrected are identical
    // (see correctAreaForOrientation's no-op default) — both are sent so
    // the browser can try either against a real detection (see
    // geometry.js's bestOverlapEitherOrientation).
    expect(regions).toEqual([{
      imageId: taggedId, sourceRegionId: `${taggedId}#region-0`, personName: 'Alice',
      rawArea: { x: 0.5, y: 0.4, w: 0.2, h: 0.15 }, correctedArea: { x: 0.5, y: 0.4, w: 0.2, h: 0.15 },
    }]);
  });

  it('stops listing a region once its embedding has been backfilled, and the new reference is usable for matching', async () => {
    const backfill = await handleRequest({
      method: 'POST', path: '/backfill-reference',
      body: {
        sourceImageId: taggedId, sourceRegionId: `${taggedId}#region-0`, personName: 'Alice',
        embedding: [0, 0], modelName: 'face-api.js', modelVersion: '0.22.2',
      },
    });
    expect(backfill.status).toEqual(200);

    const after = await handleRequest({
      method: 'POST', path: '/existing-regions',
      body: { imageIds: [taggedId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(JSON.parse(after.body).regions).toEqual([]);

    // The backfilled reference is a real, usable one: a fresh detection
    // close to it is now suggested as Alice, exactly as if she had first
    // been confirmed through the review screen.
    const detectionRes = await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0, y: 0, w: 0.1, h: 0.1 }, embedding: [0.01, 0.01] }] },
    });
    expect(JSON.parse(detectionRes.body).created[0].suggestedPersonName).toEqual('Alice');
  });

  it('only saves one reference even when the same (image, Person) is backfilled more than once in the same pass', async () => {
    // Regression test for a real bug: /existing-regions only checks
    // "already backfilled?" once, against a snapshot taken at listing
    // time — a photo with several duplicate same-named regions (exactly
    // the kind of duplication this session's other fixes clean up) all
    // come back in that one listing, since none of them are backfilled
    // yet at that moment, and the browser then calls /backfill-reference
    // once per region it was given. Confirmed against a real file: 5
    // duplicate regions for the same person produced 5 reference rows in
    // a single "Recognize Faces" run against a completely empty
    // reference set. /backfill-reference must re-check for itself at the
    // point of actually saving, not rely solely on the listing check.
    const body = {
      sourceImageId: taggedId, sourceRegionId: `${taggedId}#region-0`, personName: 'Alice',
      embedding: [0, 0], modelName: 'face-api.js', modelVersion: '0.22.2',
    };
    const first = await handleRequest({ method: 'POST', path: '/backfill-reference', body });
    const second = await handleRequest({ method: 'POST', path: '/backfill-reference', body: { ...body, sourceRegionId: `${taggedId}#region-1` } });
    expect(first.status).toEqual(200);
    expect(second.status).toEqual(200);
    expect(JSON.parse(second.body).skipped).toBe(true);

    const referenceFaces = listReferenceFaces(facesStore, 'face-api.js', '0.22.2');
    expect(referenceFaces.filter((r) => r.sourceImageId === taggedId && r.personName === 'Alice')).toHaveLength(1);
  });

  it('rejects a backfill request missing required fields', async () => {
    const res = await handleRequest({ method: 'POST', path: '/backfill-reference', body: { personName: 'Alice' } });
    expect(res.status).toEqual(400);
  });

  it('marks an image fully checked once every region on it has a reference, so a later pass skips it without reading its crate again', async () => {
    // Regression/behavior test for the "why does it keep re-examining
    // photos it already handled" complaint: without this, every
    // "Recognize Faces" click re-reads and re-checks every tagged
    // image's crate in the whole collection, even ones nothing has
    // changed about since the last click.
    await handleRequest({
      method: 'POST', path: '/backfill-reference',
      body: { sourceImageId: taggedId, sourceRegionId: `${taggedId}#region-0`, personName: 'Alice', embedding: [0, 0], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });

    const before = await handleRequest({
      method: 'POST', path: '/existing-regions',
      body: { imageIds: [taggedId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(JSON.parse(before.body).regions).toEqual([]);

    const fileRow = getFileById(mainStore, taggedId);
    const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
    expect(isBackfillFullyChecked(facesStore, taggedId, modifiedTime, 'face-api.js', '0.22.2')).toBe(true);
  });

  it('does not mark an image checked while one of its regions still needs a reference, so that one is retried next time', async () => {
    // photo.jpg has no regions of its own in this fixture; give it two
    // named ones directly via the crate, backfill only one.
    const crateJson = new TextDecoder().decode(await fsAdapter.readFile(`2025/${CRATE_FILE_NAME}`));
    const crate = loadOrCreateCrate(crateJson);
    addImageEntity(crate, {
      path: 'two-people.jpg',
      exif: { Regions: { RegionList: [
        { Name: 'Alice', Type: 'Face', Area: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } },
        { Name: 'Bob', Type: 'Face', Area: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 } },
      ] } },
      sourceModifiedAt: Date.now(),
    });
    await fsAdapter.writeFile(`2025/${CRATE_FILE_NAME}`, serializeCrate(crate));
    await fsAdapter.writeFile('2025/two-people.jpg', 'fake jpeg bytes');
    const twoPeopleId = imageEntityId('2025', 'two-people.jpg');
    upsertEntity(mainStore, { id: twoPeopleId, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'two-people.jpg', memberOf: subCrateId });
    upsertFile(mainStore, { id: twoPeopleId, entityId: twoPeopleId, filename: 'two-people.jpg', mediaType: 'image/jpeg', size: 16, relativePath: twoPeopleId });

    await handleRequest({
      method: 'POST', path: '/backfill-reference',
      body: { sourceImageId: twoPeopleId, sourceRegionId: `${twoPeopleId}#region-0`, personName: 'Alice', embedding: [0, 0], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });

    const after = await handleRequest({
      method: 'POST', path: '/existing-regions',
      body: { imageIds: [twoPeopleId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    // Bob still needs a reference, so he is still listed...
    expect(JSON.parse(after.body).regions.map((r) => r.personName)).toEqual(['Bob']);
    // ...and the image itself is not marked fully checked.
    const fileRow = getFileById(mainStore, twoPeopleId);
    const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
    expect(isBackfillFullyChecked(facesStore, twoPeopleId, modifiedTime, 'face-api.js', '0.22.2')).toBe(false);

    // Regression test: without checking again right here, the image
    // would stay unmarked until some later /existing-regions call
    // happened to notice both people already had references — a whole
    // extra "Recognize Faces" click doing nothing, for an image that was
    // actually already fully resolved by the second backfill-reference
    // call below.
    await handleRequest({
      method: 'POST', path: '/backfill-reference',
      body: { sourceImageId: twoPeopleId, sourceRegionId: `${twoPeopleId}#region-1`, personName: 'Bob', embedding: [0, 0], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(isBackfillFullyChecked(facesStore, twoPeopleId, modifiedTime, 'face-api.js', '0.22.2')).toBe(true);
  });
});

describe('POST /backfill-undetectable', () => {
  it('stops listing a region once it is marked undetectable, without ever creating a reference for it', async () => {
    await handleRequest({
      method: 'POST', path: '/backfill-undetectable',
      body: { sourceImageId: taggedId, personName: 'Alice', modelName: 'face-api.js', modelVersion: '0.22.2' },
    });

    const after = await handleRequest({
      method: 'POST', path: '/existing-regions',
      body: { imageIds: [taggedId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(JSON.parse(after.body).regions).toEqual([]);
    expect(listReferenceFaces(facesStore, 'face-api.js', '0.22.2')).toEqual([]);
  });

  it('marks the image fully checked once its only region is given up on, so it is not re-examined next time', async () => {
    await handleRequest({
      method: 'POST', path: '/backfill-undetectable',
      body: { sourceImageId: taggedId, personName: 'Alice', modelName: 'face-api.js', modelVersion: '0.22.2' },
    });

    const fileRow = getFileById(mainStore, taggedId);
    const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
    expect(isBackfillFullyChecked(facesStore, taggedId, modifiedTime, 'face-api.js', '0.22.2')).toBe(true);
  });

  it('does not mark an image checked while a sibling region still needs a reference (only one of two people given up on)', async () => {
    const crateJson = new TextDecoder().decode(await fsAdapter.readFile(`2025/${CRATE_FILE_NAME}`));
    const crate = loadOrCreateCrate(crateJson);
    addImageEntity(crate, {
      path: 'two-people-2.jpg',
      exif: { Regions: { RegionList: [
        { Name: 'Alice', Type: 'Face', Area: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } },
        { Name: 'Bob', Type: 'Face', Area: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 } },
      ] } },
      sourceModifiedAt: Date.now(),
    });
    await fsAdapter.writeFile(`2025/${CRATE_FILE_NAME}`, serializeCrate(crate));
    await fsAdapter.writeFile('2025/two-people-2.jpg', 'fake jpeg bytes');
    const twoPeopleId = imageEntityId('2025', 'two-people-2.jpg');
    upsertEntity(mainStore, { id: twoPeopleId, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'two-people-2.jpg', memberOf: subCrateId });
    upsertFile(mainStore, { id: twoPeopleId, entityId: twoPeopleId, filename: 'two-people-2.jpg', mediaType: 'image/jpeg', size: 16, relativePath: twoPeopleId });

    await handleRequest({
      method: 'POST', path: '/backfill-undetectable',
      body: { sourceImageId: twoPeopleId, personName: 'Alice', modelName: 'face-api.js', modelVersion: '0.22.2' },
    });

    const fileRow = getFileById(mainStore, twoPeopleId);
    const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
    expect(isBackfillFullyChecked(facesStore, twoPeopleId, modifiedTime, 'face-api.js', '0.22.2')).toBe(false);

    const listed = await handleRequest({
      method: 'POST', path: '/existing-regions',
      body: { imageIds: [twoPeopleId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(JSON.parse(listed.body).regions.map((r) => r.personName)).toEqual(['Bob']);

    await handleRequest({
      method: 'POST', path: '/backfill-reference',
      body: { sourceImageId: twoPeopleId, sourceRegionId: `${twoPeopleId}#region-1`, personName: 'Bob', embedding: [0, 0], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(isBackfillFullyChecked(facesStore, twoPeopleId, modifiedTime, 'face-api.js', '0.22.2')).toBe(true);
  });
});

describe('POST /detections', () => {
  it('creates a pending, unmatched detection when there is no reference set yet', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, embedding: [0, 0] }] },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.created).toHaveLength(1);
    expect(parsed.created[0].status).toEqual('pending');
    expect(parsed.created[0].suggestedPersonName).toBeNull();

    const scanStatus = await handleRequest({
      method: 'POST', path: '/scan-status', body: { imageIds: [photoId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(JSON.parse(scanStatus.body).scanned).toEqual([photoId]);
  });

  it('suggests a matching known person when the embedding is close to one of their references', async () => {
    addReferenceFace(facesStore, {
      id: 'ref-alice', personId: personEntityId('Alice'), personName: 'Alice',
      sourceRegionId: 'other.jpg#region-0', sourceImageId: 'other.jpg', embedding: [0, 0],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });

    const res = await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0, y: 0, w: 0.1, h: 0.1 }, embedding: [0.01, 0.01] }] },
    });
    const detection = JSON.parse(res.body).created[0];
    expect(detection.status).toEqual('pending');
    expect(detection.suggestedPersonName).toEqual('Alice');
  });

  it('auto-ignores a detection matching a "stranger" reference, without surfacing it for review', async () => {
    addReferenceFace(facesStore, {
      id: 'ref-stranger', personId: null, personName: null,
      sourceRegionId: null, sourceImageId: 'other.jpg', embedding: [5, 5],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });

    const res = await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0, y: 0, w: 0.1, h: 0.1 }, embedding: [5.01, 5.01] }] },
    });
    const detection = JSON.parse(res.body).created[0];
    expect(detection.status).toEqual('auto_ignored');

    const pending = await handleRequest({ method: 'GET', path: '/detections', query: { status: 'pending' } });
    expect(JSON.parse(pending.body).total).toEqual(0);
  });

  it('drops a detected face that overlaps an already-tagged region, without creating a detection for it', async () => {
    // Regression test for a real bug: face-api.js's own detector has no
    // idea "tagged.jpg" already has a named region for Alice (see the
    // fixture, Area {x:0.5,y:0.4,w:0.2,h:0.15}) — without this check, it
    // would detect that same physical face again, suggest Alice (a near-
    // exact embedding match to her own just-backfilled reference), and
    // confirming it would write a second, duplicate MWG region onto the
    // same photo with a second reference for the same (image, Alice)
    // pair — exactly what a real user's faces-index.sqlite showed
    // happening, over and over, on every "Recognize Faces" run.
    const res = await handleRequest({
      method: 'POST', path: '/detections',
      body: {
        imageId: taggedId, modelName: 'face-api.js', modelVersion: '0.22.2',
        faces: [
          // Overlaps Alice's own tagged region almost exactly (Area
          // center 0.5,0.4 w0.2 h0.15 -> top-left 0.4,0.325 w0.2 h0.15).
          { box: { x: 0.4, y: 0.325, w: 0.2, h: 0.15 }, embedding: [1, 1] },
          // A genuinely different part of the photo — a real, new face.
          { box: { x: 0, y: 0, w: 0.1, h: 0.1 }, embedding: [2, 2] },
        ],
      },
    });
    const created = JSON.parse(res.body).created;
    expect(created).toHaveLength(1);
    expect(created[0].box).toEqual({ x: 0, y: 0, w: 0.1, h: 0.1 });
  });

  it('still recognises an already-tagged region as such when the orientation correction would move it away from the real face (Apple Photos case)', async () => {
    // Regression test for a real bug found in a real collection: for
    // this file's Orientation, correcting John's Area (as digiKam-style
    // files need) lands the box nowhere near a real detection of the
    // same face, so a naive single-interpretation check would treat it
    // as a brand new face every single "Recognize Faces" run — see
    // Spec.md's Face Recognition section and geometry.js's
    // bestOverlapEitherOrientation. The box below is a real face-api.js
    // detection of this same file, in its own (uncorrected) frame.
    const res = await handleRequest({
      method: 'POST', path: '/detections',
      body: {
        imageId: orientedId, modelName: 'face-api.js', modelVersion: '0.22.2',
        faces: [{ box: { x: 0.36178652445475257, y: 0.23923218250274658, w: 0.15869951248168945, h: 0.16543585062026978 }, embedding: [1] }],
      },
    });
    expect(JSON.parse(res.body).created).toEqual([]);
  });
});

describe('GET /detections', () => {
  it('lists detections with the image title attached, filtered by status', async () => {
    await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'm', modelVersion: '1', faces: [{ box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1] }] },
    });
    const res = await handleRequest({ method: 'GET', path: '/detections', query: { status: 'pending' } });
    const parsed = JSON.parse(res.body);
    expect(parsed.total).toEqual(1);
    expect(parsed.detections[0].imageId).toEqual(photoId);
    expect(parsed.detections[0].imageTitle).toEqual('photo.jpg');
  });
});

describe('POST /ignore', () => {
  it('marks a detection ignored so it drops out of the pending review list', async () => {
    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'm', modelVersion: '1', faces: [{ box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1] }] },
    })).body).created[0];

    const res = await handleRequest({ method: 'POST', path: '/ignore', body: { detectionId: created.id } });
    expect(res.status).toEqual(200);

    const pending = await handleRequest({ method: 'GET', path: '/detections', query: { status: 'pending' } });
    expect(JSON.parse(pending.body).total).toEqual(0);
  });
});

describe('POST /ignore-stranger', () => {
  it('adds a permanent stranger reference that suppresses a later close match', async () => {
    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'm', modelVersion: '1', faces: [{ box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [9, 9] }] },
    })).body).created[0];

    await handleRequest({ method: 'POST', path: '/ignore-stranger', body: { detectionId: created.id } });

    const second = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'm', modelVersion: '1', faces: [{ box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [9.01, 9.01] }] },
    })).body).created[0];
    expect(second.status).toEqual('auto_ignored');
  });
});

describe('POST /reject-suggestion', () => {
  it('re-matches against the next-closest reference once the current suggestion is rejected, excluding it for good', async () => {
    addReferenceFace(facesStore, {
      id: 'ref-alice', personId: personEntityId('Alice'), personName: 'Alice',
      sourceRegionId: 'x.jpg#region-0', sourceImageId: 'x.jpg', embedding: [0, 0],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });
    addReferenceFace(facesStore, {
      id: 'ref-bob', personId: personEntityId('Bob'), personName: 'Bob',
      sourceRegionId: 'y.jpg#region-0', sourceImageId: 'y.jpg', embedding: [0.05, 0.05],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });

    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0, y: 0, w: 0.1, h: 0.1 }, embedding: [0.01, 0.01] }] },
    })).body).created[0];
    expect(created.suggestedPersonName).toEqual('Alice');

    const firstReject = await handleRequest({ method: 'POST', path: '/reject-suggestion', body: { detectionId: created.id } });
    expect(firstReject.status).toEqual(200);
    let pending = JSON.parse((await handleRequest({ method: 'GET', path: '/detections', query: { status: 'pending' } })).body).detections;
    expect(pending[0].suggestedPersonName).toEqual('Bob');

    // Rejecting again excludes Bob too, on top of Alice from before —
    // with nobody left to suggest, it falls back to unmatched rather
    // than re-suggesting either rejected Person.
    await handleRequest({ method: 'POST', path: '/reject-suggestion', body: { detectionId: created.id } });
    pending = JSON.parse((await handleRequest({ method: 'GET', path: '/detections', query: { status: 'pending' } })).body).detections;
    expect(pending[0].suggestedPersonName).toBeNull();
  });

  it('auto-ignores a detection whose next-best match after rejection turns out to be a stranger', async () => {
    addReferenceFace(facesStore, {
      id: 'ref-alice', personId: personEntityId('Alice'), personName: 'Alice',
      sourceRegionId: 'x.jpg#region-0', sourceImageId: 'x.jpg', embedding: [0, 0],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });
    addReferenceFace(facesStore, {
      id: 'ref-stranger', personId: null, personName: null,
      sourceRegionId: null, sourceImageId: 'z.jpg', embedding: [0.05, 0.05],
      modelName: 'face-api.js', modelVersion: '0.22.2',
    });

    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0, y: 0, w: 0.1, h: 0.1 }, embedding: [0.01, 0.01] }] },
    })).body).created[0];
    expect(created.suggestedPersonName).toEqual('Alice');

    await handleRequest({ method: 'POST', path: '/reject-suggestion', body: { detectionId: created.id } });
    const pending = JSON.parse((await handleRequest({ method: 'GET', path: '/detections', query: { status: 'pending' } })).body).detections;
    expect(pending).toHaveLength(0);
  });

  it('rejects a detection with no current suggestion to reject', async () => {
    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'm', modelVersion: '1', faces: [{ box: { x: 0, y: 0, w: 1, h: 1 }, embedding: [1] }] },
    })).body).created[0];
    const res = await handleRequest({ method: 'POST', path: '/reject-suggestion', body: { detectionId: created.id } });
    expect(res.status).toEqual(400);
  });

  it('404s for an unknown detection', async () => {
    const res = await handleRequest({ method: 'POST', path: '/reject-suggestion', body: { detectionId: 'nope' } });
    expect(res.status).toEqual(404);
  });
});

describe('POST /confirm', () => {
  it('requires a writeFaceRegion implementation (unavailable in the browser-only run mode)', async () => {
    const handler = createFacesHandler({ mainStore, facesStore, fsAdapter, writeFaceRegion: null });
    const res = await handler({ method: 'POST', path: '/confirm', body: { detectionId: 'x', personName: 'Bob' } });
    expect(res.status).toEqual(501);
  });

  it('rejects a blank person name', async () => {
    const res = await handleRequest({ method: 'POST', path: '/confirm', body: { detectionId: 'x', personName: '  ' } });
    expect(res.status).toEqual(400);
  });

  it('serializes two concurrent confirmations for the same image, so neither one\'s region is lost to the other', async () => {
    // Regression test for a real bug: writeFaceRegion (and separately,
    // the crate write below it) is a read-the-current-state-then-write-
    // the-whole-thing-back operation. Fired without awaiting one before
    // the other — exactly what happens confirming two different people
    // in the same photo in quick succession — two of these can both read
    // the "before" state, and whichever finishes writing last overwrites
    // the other's change entirely. A real user's collection showed
    // exactly this: two people tagged in one photo, only one actually
    // ending up saved.
    const detectionA = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, embedding: [1] }] },
    })).body).created[0];
    const detectionB = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, embedding: [2] }] },
    })).body).created[0];

    // Faithfully simulates the real exiftool adapter's own read-then-
    // (after a delay)-write shape, including its race: each call snapshots
    // "what's on the file" immediately, waits (standing in for real I/O
    // latency), then overwrites the file with that stale snapshot plus
    // its own addition — losing anything written by another call in the
    // meantime, unless the two are serialized so one never starts until
    // the other has fully finished.
    let fileRegions = [];
    writeFaceRegion.mockImplementation(async (relativePath, { name, area }) => {
      const snapshot = [...fileRegions];
      await new Promise((resolve) => setTimeout(resolve, 20));
      fileRegions = [...snapshot, { Name: name, Type: 'Face', Area: area }];
    });
    extractExif.mockImplementation(async () => ({
      exif: { Regions: { RegionList: [...fileRegions] } },
      error: null,
    }));

    await Promise.all([
      handleRequest({ method: 'POST', path: '/confirm', body: { detectionId: detectionA.id, personName: 'Alice' } }),
      handleRequest({ method: 'POST', path: '/confirm', body: { detectionId: detectionB.id, personName: 'Bob' } }),
    ]);

    const crateJson = new TextDecoder().decode(await fsAdapter.readFile(`2025/${CRATE_FILE_NAME}`));
    const record = readImageRecord(loadOrCreateCrate(crateJson), 'photo.jpg');
    expect(record.people.sort()).toEqual(['Alice', 'Bob']);
  });

  it('404s for an unknown detection', async () => {
    const res = await handleRequest({ method: 'POST', path: '/confirm', body: { detectionId: 'nope', personName: 'Bob' } });
    expect(res.status).toEqual(404);
  });

  it('writes the region to the file, rescans the image, and records a reference face', async () => {
    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0.3, y: 0.4, w: 0.2, h: 0.1 }, embedding: [1, 2, 3] }] },
    })).body).created[0];

    // Simulates what re-reading the file after exiftool wrote the region
    // would see — extractExif is mocked (see vi.mock above) since the
    // fixture file is not a real, exiftool-writable image; the actual
    // exiftool read/write mechanics are verified separately (see
    // Spec.md's Face Recognition section and this session's live checks).
    extractExif.mockResolvedValue({
      exif: { Regions: { RegionList: [{ Name: 'Bob', Type: 'Face', Area: { x: 0.4, y: 0.45, w: 0.2, h: 0.1 } }] } },
      error: null,
    });

    const res = await handleRequest({ method: 'POST', path: '/confirm', body: { detectionId: created.id, personName: 'Bob' } });
    expect(res.status).toEqual(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.personName).toEqual('Bob');
    expect(parsed.personId).toEqual(personEntityId('Bob'));

    // The injected writer was called with the detection's own box and
    // the file's fsAdapter-relative path.
    expect(writeFaceRegion).toHaveBeenCalledWith(photoId, { name: 'Bob', area: { x: 0.3, y: 0.4, w: 0.2, h: 0.1 } });

    // The crate on disk now has Bob as a region and as a depicted person.
    const crateJson = new TextDecoder().decode(await fsAdapter.readFile(`2025/${CRATE_FILE_NAME}`));
    const record = readImageRecord(loadOrCreateCrate(crateJson), 'photo.jpg');
    expect(record.people).toEqual(['Bob']);

    // The main index reflects the same, without waiting for a rescan.
    expect(listFacetValuesForEntity(mainStore, photoId, 'people')).toEqual(['Bob']);

    // The detection is resolved, and a reference face now exists for Bob.
    expect(listDetections(facesStore, { status: 'confirmed' })).toHaveLength(1);
    expect(listDetections(facesStore, { status: 'pending' })).toHaveLength(0);

    // The faces crate was written for inspectability.
    expect(await fsAdapter.exists('_rocphotos/faces/ro-crate-metadata.json')).toBe(true);
  });

  it('records the new reference under the same (collection-relative) region id /existing-regions itself computes, so a confirmed face is never re-offered for backfill', async () => {
    // Regression test for a real bug: sourceRegionId was previously built
    // from the crate-relative image path, not the collection-relative
    // one — for any image outside the root crate (this fixture's photo.jpg
    // lives in the '2025' sub-crate), that never matched what
    // /existing-regions computes for the same region, so a just-confirmed
    // face kept looking unbackfilled forever and was silently reprocessed
    // on every later "Recognize Faces" run.
    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0.3, y: 0.4, w: 0.2, h: 0.1 }, embedding: [1, 2, 3] }] },
    })).body).created[0];
    extractExif.mockResolvedValue({
      exif: { Regions: { RegionList: [{ Name: 'Bob', Type: 'Face', Area: { x: 0.4, y: 0.45, w: 0.2, h: 0.1 } }] } },
      error: null,
    });
    await handleRequest({ method: 'POST', path: '/confirm', body: { detectionId: created.id, personName: 'Bob' } });

    const existing = await handleRequest({
      method: 'POST', path: '/existing-regions',
      body: { imageIds: [photoId], modelName: 'face-api.js', modelVersion: '0.22.2' },
    });
    expect(JSON.parse(existing.body).regions).toEqual([]);
  });

  it('updates a shared AROCAPI read cache, so the viewer\'s tags/"Show faces" overlay reflect a confirm immediately rather than a stale pre-confirm crate', async () => {
    // Regression test for a real bug: the AROCAPI handler (createHandler)
    // keeps a long-lived in-memory cache of parsed crates for GET
    // /entity/{id}/metadata, which the viewer uses for its tags and
    // "Show faces" overlay. The faces handler writes the confirmed
    // region straight to disk, correctly, but without also updating that
    // same cache (if shared with it — see createFacesHandler's
    // crateCache param), a long-running `rocphotos serve` process kept
    // serving whatever it had last read for that crate, so a newly
    // confirmed face never showed up there until the server restarted,
    // even though the crate file and the index were both already correct.
    const crateCache = new Map();
    const arocapiHandler = createHandler({ store: mainStore, fsAdapter, crateCache });
    const facesHandlerWithSharedCache = createFacesHandler({ mainStore, facesStore, fsAdapter, writeFaceRegion, crateCache });

    // Populates the AROCAPI handler's cache with the pre-confirm crate —
    // the same thing opening the viewer on this photo beforehand would do.
    const before = await arocapiHandler({ method: 'GET', path: `/entity/${encodeURIComponent(photoId)}/metadata` });
    expect(JSON.parse(before.body).about).toBeUndefined();

    const created = JSON.parse((await facesHandlerWithSharedCache({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0.3, y: 0.4, w: 0.2, h: 0.1 }, embedding: [1, 2, 3] }] },
    })).body).created[0];
    extractExif.mockResolvedValue({
      exif: { Regions: { RegionList: [{ Name: 'Bob', Type: 'Face', Area: { x: 0.4, y: 0.45, w: 0.2, h: 0.1 } }] } },
      error: null,
    });
    await facesHandlerWithSharedCache({ method: 'POST', path: '/confirm', body: { detectionId: created.id, personName: 'Bob' } });

    const after = await arocapiHandler({ method: 'GET', path: `/entity/${encodeURIComponent(photoId)}/metadata` });
    expect(JSON.parse(after.body).about[0].name).toEqual('Bob');
  });

  it('rejects confirming a detection that has already been resolved', async () => {
    const created = JSON.parse((await handleRequest({
      method: 'POST', path: '/detections',
      body: { imageId: photoId, modelName: 'face-api.js', modelVersion: '0.22.2', faces: [{ box: { x: 0, y: 0, w: 0.1, h: 0.1 }, embedding: [1] }] },
    })).body).created[0];
    await handleRequest({ method: 'POST', path: '/ignore', body: { detectionId: created.id } });

    const res = await handleRequest({ method: 'POST', path: '/confirm', body: { detectionId: created.id, personName: 'Bob' } });
    expect(res.status).toEqual(400);
  });
});
