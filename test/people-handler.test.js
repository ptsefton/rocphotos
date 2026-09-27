import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { createPeopleHandler } from '../src/core/people/handler.js';
import { ensureFacesSchema, addReferenceFace, addDetection, listReferenceFaces, getDetection } from '../src/core/faces/store.js';
import {
  ensureSchema as ensureMainSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  crateEntityId,
  imageEntityId,
  personEntityId,
  getEntityById,
  facetCounts,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
} from '../src/core/db/store.js';
import { loadOrCreateCrate, serializeCrate, addImageEntity, addStandoffFaceRegion, readImageRecord, CRATE_FILE_NAME } from '../src/core/crateBuilder.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;
let mainStore;
let facesStore;
let fsAdapter;
let handleRequest;

const crate2024Id = crateEntityId('2024');
const crate2025Id = crateEntityId('2025');
const aId = imageEntityId('2024', 'a.jpg');
const bId = imageEntityId('2025', 'b.jpg');
const cId = imageEntityId('2025', 'c.jpg');

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

beforeEach(async () => {
  // a.jpg (2024): EXIF-derived region for "jane smith" (the identity being merged away)
  const crate2024 = loadOrCreateCrate(null);
  crate2024.rootDataset.name = '2024';
  addImageEntity(crate2024, {
    path: 'a.jpg',
    exif: { Regions: { RegionList: { Name: 'jane smith', Type: 'Face', Area: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } } },
    sourceModifiedAt: Date.now(),
  });

  // b.jpg (2025): already depicts the surviving identity "Jane Smith" via a standoff region
  // c.jpg (2025): depicts "jane smith" too, in the same crate as b.jpg
  const crate2025 = loadOrCreateCrate(null);
  crate2025.rootDataset.name = '2025';
  addImageEntity(crate2025, { path: 'b.jpg', exif: {}, sourceModifiedAt: Date.now() });
  addStandoffFaceRegion(crate2025, 'b.jpg', {
    name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
  });
  addImageEntity(crate2025, {
    path: 'c.jpg',
    exif: { Regions: { RegionList: { Name: 'jane smith', Type: 'Face', Area: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 } } } },
    sourceModifiedAt: Date.now(),
  });

  currentRoot = await createFixtureTree({
    'ro-crate-metadata.json': serializeCrate(loadOrCreateCrate(null)),
    2024: { 'ro-crate-metadata.json': serializeCrate(crate2024), 'a.jpg': 'fake' },
    2025: { 'ro-crate-metadata.json': serializeCrate(crate2025), 'b.jpg': 'fake', 'c.jpg': 'fake' },
  });

  fsAdapter = createNodeFsAdapter(currentRoot);
  mainStore = openNodeSqlite(':memory:');
  ensureMainSchema(mainStore);
  facesStore = openNodeSqlite(':memory:');
  ensureFacesSchema(facesStore);

  upsertRoCrate(mainStore, { id: crate2024Id, path: '2024', name: '2024' });
  upsertEntity(mainStore, { id: crate2024Id, roCrateId: crate2024Id, entityType: ENTITY_TYPE_COLLECTION, name: '2024' });
  upsertRoCrate(mainStore, { id: crate2025Id, path: '2025', name: '2025' });
  upsertEntity(mainStore, { id: crate2025Id, roCrateId: crate2025Id, entityType: ENTITY_TYPE_COLLECTION, name: '2025' });

  for (const [id, roCrateId, path, record] of [
    [aId, crate2024Id, 'a.jpg', readImageRecord(crate2024, 'a.jpg')],
    [bId, crate2025Id, 'b.jpg', readImageRecord(crate2025, 'b.jpg')],
    [cId, crate2025Id, 'c.jpg', readImageRecord(crate2025, 'c.jpg')],
  ]) {
    upsertEntity(mainStore, { id, roCrateId, entityType: ENTITY_TYPE_IMAGE, name: path, memberOf: roCrateId, title: path });
    upsertFile(mainStore, { id, entityId: id, filename: path, mediaType: 'image/jpeg', size: 4, relativePath: id });
    for (const name of record.people) {
      mainStore.run("INSERT INTO entity_facets (entity_id, facet_name, value) VALUES (?, 'people', ?)", [id, name]);
    }
  }

  addReferenceFace(facesStore, {
    id: 'ref-1', personId: personEntityId('jane smith'), personName: 'jane smith', sourceRegionId: 'a.jpg#region-0',
    sourceImageId: aId, embedding: [1, 2, 3], modelName: 'm', modelVersion: '1',
  });
  addDetection(facesStore, {
    id: 'det-1', imageId: cId, box: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, embedding: [4, 5, 6],
    suggestedPersonId: personEntityId('jane smith'), suggestedPersonName: 'jane smith', status: 'pending', modelName: 'm', modelVersion: '1',
  });

  handleRequest = createPeopleHandler({ mainStore, facesStore, fsAdapter });
});

describe('GET /', () => {
  it('lists every distinct Person with its image count', async () => {
    const res = await handleRequest({ method: 'GET', path: '/' });
    const { people } = JSON.parse(res.body);
    expect(people).toEqual(expect.arrayContaining([
      { name: 'jane smith', imageCount: 2 },
      { name: 'Jane Smith', imageCount: 1 },
    ]));
  });
});

describe('POST /merge', () => {
  it('rejects fewer than two source names', async () => {
    const res = await handleRequest({ method: 'POST', path: '/merge', body: { sourceNames: ['jane smith'], targetName: 'Jane Smith' } });
    expect(res.status).toEqual(400);
  });

  it('rejects a missing targetName', async () => {
    const res = await handleRequest({ method: 'POST', path: '/merge', body: { sourceNames: ['jane smith', 'Jane Smith'] } });
    expect(res.status).toEqual(400);
  });

  it('merges across multiple crates into the surviving name, updating crate files, the main index, and the faces index', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/merge',
      body: { sourceNames: ['jane smith', 'Jane Smith'], targetName: 'Jane Smith' },
    });
    expect(res.status).toEqual(200);
    const result = JSON.parse(res.body);
    expect(result.imagesUpdated).toEqual(2); // a.jpg and c.jpg — b.jpg already was "Jane Smith"

    // Main index: "jane smith" facet is gone, "Jane Smith" now covers all three images.
    const peopleFacets = facetCounts(mainStore, 'people', {});
    expect(peopleFacets).toEqual([{ value: 'Jane Smith', count: 3 }]);
    expect(getEntityById(mainStore, personEntityId('jane smith'))).toBeUndefined();
    expect(getEntityById(mainStore, personEntityId('Jane Smith'))).toBeTruthy();

    // Crate files on disk were rewritten to match.
    const rewritten2024 = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile('2024/' + CRATE_FILE_NAME)));
    expect(readImageRecord(rewritten2024, 'a.jpg').people).toEqual(['Jane Smith']);
    const rewritten2025 = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile('2025/' + CRATE_FILE_NAME)));
    expect(readImageRecord(rewritten2025, 'c.jpg').people).toEqual(['Jane Smith']);
    expect(readImageRecord(rewritten2025, 'b.jpg').people).toEqual(['Jane Smith']);

    // Faces index: the reference and the detection's suggestion both now point at the surviving identity.
    const [reference] = listReferenceFaces(facesStore, 'm', '1');
    expect(reference.personId).toEqual(personEntityId('Jane Smith'));
    expect(reference.personName).toEqual('Jane Smith');
    const detection = getDetection(facesStore, 'det-1');
    expect(detection.suggested_person_id).toEqual(personEntityId('Jane Smith'));

    // The merged-away identity's own Person node must not be left
    // dangling, unreferenced, in either crate that used to hold it.
    expect(rewritten2024.getEntity(personEntityId('jane smith'))).toBeUndefined();
    expect(rewritten2025.getEntity(personEntityId('jane smith'))).toBeUndefined();
  });

  it('merges into a brand new name typed by the user, not just one of the source names', async () => {
    const res = await handleRequest({
      method: 'POST', path: '/merge',
      body: { sourceNames: ['jane smith', 'Jane Smith'], targetName: 'Jane Doe' },
    });
    expect(res.status).toEqual(200);

    const peopleFacets = facetCounts(mainStore, 'people', {});
    expect(peopleFacets).toEqual([{ value: 'Jane Doe', count: 3 }]);
    expect(getEntityById(mainStore, personEntityId('jane smith'))).toBeUndefined();
    expect(getEntityById(mainStore, personEntityId('Jane Smith'))).toBeUndefined();
    expect(getEntityById(mainStore, personEntityId('Jane Doe'))).toBeTruthy();
  });
});
