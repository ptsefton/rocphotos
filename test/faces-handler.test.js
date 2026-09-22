import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { createFacesHandler } from '../src/core/faces/handler.js';
import { ensureFacesSchema, addReferenceFace, listDetections } from '../src/core/faces/store.js';
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

  currentRoot = await createFixtureTree({
    'ro-crate-metadata.json': serializeCrate(loadOrCreateCrate(null)),
    2025: {
      'ro-crate-metadata.json': serializeCrate(subCrate),
      'photo.jpg': 'fake jpeg bytes',
      'tagged.jpg': 'fake jpeg bytes',
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
    expect(regions).toEqual([{ imageId: taggedId, sourceRegionId: `${taggedId}#region-0`, personName: 'Alice', area: { x: 0.5, y: 0.4, w: 0.2, h: 0.15 } }]);
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

  it('rejects a backfill request missing required fields', async () => {
    const res = await handleRequest({ method: 'POST', path: '/backfill-reference', body: { personName: 'Alice' } });
    expect(res.status).toEqual(400);
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
