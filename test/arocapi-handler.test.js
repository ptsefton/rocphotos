import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { createHandler } from '../src/core/arocapi/handler.js';
import {
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  setEntityFacetValues,
  crateEntityId,
  imageEntityId,
  personEntityId,
  petEntityId,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
  ENTITY_TYPE_PERSON,
  ENTITY_TYPE_PET,
  listFacetValuesForEntity,
} from '../src/core/db/store.js';
import { loadOrCreateCrate, serializeCrate, addImageEntity, addSubCrateReference, CRATE_FILE_NAME } from '../src/core/crateBuilder.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';
import { setExportPathSetting, saveConfig } from '../src/core/config.js';

let currentRoot = null;
let handleRequest;
let db;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

// Builds a small, real collection on disk (root + one sub-crate with two
// images) and a matching index, the same shape `scan` produces, so the
// handler is exercised against real crate files, not just index rows.
beforeEach(async () => {
  const rootId = crateEntityId('');
  const subCrateId = crateEntityId('2025/03/10');

  const subCrate = loadOrCreateCrate(null);
  subCrate.rootDataset.name = '2025/03/10';
  const photoRecord = addImageEntity(subCrate, {
    path: 'photo.jpg',
    exif: {
      Make: 'Google', Model: 'Pixel 6a', LensModel: 'Pixel 6a back camera',
      Keywords: ['Bird', 'Background'],
      Rating: 5,
      Caption: 'A heron at the lake',
      Regions: { RegionList: [{ Name: 'Peter Malcolm Sefton', Type: 'Face' }, { Name: 'Rex', Type: 'Pet' }] },
    },
    thumbnailPath: 'thumbnails/photo.jpg.thumb.jpg',
    sourceModifiedAt: Date.now(),
  });
  const undatedRecord = addImageEntity(subCrate, { path: 'undated.jpg' });

  const rootCrate = loadOrCreateCrate(null);
  rootCrate.rootDataset.name = 'Photo Collection';
  addSubCrateReference(rootCrate, '2025/03/10');

  currentRoot = await createFixtureTree({
    'ro-crate-metadata.json': serializeCrate(rootCrate),
    '2025': {
      '03': {
        '10': {
          'ro-crate-metadata.json': serializeCrate(subCrate),
          'photo.jpg': 'fake jpeg bytes',
          'undated.jpg': 'other fake bytes',
          thumbnails: { 'photo.jpg.thumb.jpg': 'fake thumbnail bytes' },
        },
      },
    },
  });

  const fsAdapter = createNodeFsAdapter(currentRoot);
  db = openNodeSqlite(':memory:');
  ensureSchema(db);

  upsertRoCrate(db, { id: rootId, path: '.', name: 'Photo Collection' });
  upsertEntity(db, { id: rootId, roCrateId: rootId, entityType: ENTITY_TYPE_COLLECTION, name: 'Photo Collection' });

  upsertRoCrate(db, { id: subCrateId, path: '2025/03/10', name: '2025/03/10' });
  upsertEntity(db, { id: subCrateId, roCrateId: subCrateId, entityType: ENTITY_TYPE_COLLECTION, name: '2025/03/10', memberOf: rootId });

  const photoId = imageEntityId('2025/03/10', 'photo.jpg');
  upsertEntity(db, {
    id: photoId, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg', memberOf: subCrateId,
    title: photoRecord.title, description: photoRecord.description, processingError: photoRecord.processingError,
    dateCreated: photoRecord.dateCreated,
  });
  setEntityFacetValues(db, photoId, 'camera', ['Google Pixel 6a']);
  setEntityFacetValues(db, photoId, 'lens', ['Pixel 6a back camera']);
  setEntityFacetValues(db, photoId, 'keyword', ['Bird', 'Background']);
  setEntityFacetValues(db, photoId, 'rating', ['5']);
  setEntityFacetValues(db, photoId, 'people', photoRecord.people);
  setEntityFacetValues(db, photoId, 'pets', photoRecord.pets);
  upsertEntity(db, { id: personEntityId('Peter Malcolm Sefton'), roCrateId: subCrateId, entityType: ENTITY_TYPE_PERSON, name: 'Peter Malcolm Sefton' });
  upsertEntity(db, { id: petEntityId('Rex'), roCrateId: subCrateId, entityType: ENTITY_TYPE_PET, name: 'Rex' });
  upsertFile(db, { id: photoId, entityId: photoId, filename: 'photo.jpg', mediaType: 'image/jpeg', size: 16, relativePath: photoId });

  const undatedId = imageEntityId('2025/03/10', 'undated.jpg');
  upsertEntity(db, { id: undatedId, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'undated.jpg', memberOf: subCrateId });
  upsertFile(db, { id: undatedId, entityId: undatedId, filename: 'undated.jpg', mediaType: 'image/jpeg', size: 16, relativePath: undatedId });

  handleRequest = createHandler({ store: db, fsAdapter });
});

describe('writing an edit back into the original file', () => {
  // The collection's own opt-in (Settings' "Write metadata into photo
  // files"); exiftool itself is stubbed, since what matters here is
  // whether it is called at all, and with what.
  function handlerWith({ writeBackEnabled }) {
    const written = [];
    const handler = createHandler({
      store: db,
      fsAdapter: createNodeFsAdapter(currentRoot),
      writeBackEnabled,
      writeImageMetadata: async (absolutePath, metadata) => written.push({ absolutePath, metadata }),
    });
    return { handler, written };
  }

  it('writes the edit into the photo when the collection has opted in', async () => {
    const { handler, written } = handlerWith({ writeBackEnabled: true });

    await handler({ method: 'POST', path: '/edit/keywords', body: { ids: ['2025/03/10/photo.jpg'], add: ['sunset'] } });

    expect(written).toHaveLength(1);
    expect(written[0].absolutePath).toEqual(`${currentRoot}/2025/03/10/photo.jpg`);
    expect(written[0].metadata.keywords).toContain('sunset');
  });

  it.each([
    ['/edit/rating', { rating: 4 }],
    ['/edit/title', { title: 'A new title' }],
    ['/edit/description', { description: 'A new caption' }],
  ])('writes it for %s too — one setting, every kind of edit', async (path, extra) => {
    const { handler, written } = handlerWith({ writeBackEnabled: true });

    await handler({ method: 'POST', path, body: { ids: ['2025/03/10/photo.jpg'], ...extra } });

    expect(written).toHaveLength(1);
  });

  it('leaves the original file completely alone when the collection has not opted in', async () => {
    const { handler, written } = handlerWith({ writeBackEnabled: false });

    const res = await handler({ method: 'POST', path: '/edit/keywords', body: { ids: ['2025/03/10/photo.jpg'], add: ['sunset'] } });

    expect(written).toEqual([]);
    // The edit itself still happened, in the crate and the index.
    expect(JSON.parse(res.body).updated).toEqual(['2025/03/10/photo.jpg']);
    expect(listFacetValuesForEntity(db, '2025/03/10/photo.jpg', 'keyword')).toContain('sunset');
  });

  it('defaults to not writing, so a caller that forgets the opt-in cannot modify originals', async () => {
    const written = [];
    const handler = createHandler({
      store: db,
      fsAdapter: createNodeFsAdapter(currentRoot),
      writeImageMetadata: async (...args) => written.push(args),
    });

    await handler({ method: 'POST', path: '/edit/keywords', body: { ids: ['2025/03/10/photo.jpg'], add: ['sunset'] } });

    expect(written).toEqual([]);
  });

  it('reports a failed file write without failing the edit, which has already happened', async () => {
    const handler = createHandler({
      store: db,
      fsAdapter: createNodeFsAdapter(currentRoot),
      writeBackEnabled: true,
      writeImageMetadata: async () => { throw new Error('exiftool exploded'); },
    });

    const res = await handler({ method: 'POST', path: '/edit/keywords', body: { ids: ['2025/03/10/photo.jpg'], add: ['sunset'] } });

    expect(res.status).toEqual(200);
    const result = JSON.parse(res.body);
    expect(result.updated).toEqual(['2025/03/10/photo.jpg']);
    expect(result.errors[0].message).toMatch(/could not be written into the file/);
    expect(listFacetValuesForEntity(db, '2025/03/10/photo.jpg', 'keyword')).toContain('sunset');
  });
});

describe('GET /capabilities', () => {
  it('declares the supported facets', async () => {
    const res = await handleRequest({ method: 'GET', path: '/capabilities' });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body).search.facets).toEqual(['camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'albums', 'year']);
  });
});

describe('GET /date-facet', () => {
  // photo.jpg (from the shared fixture above) has today's date, not a
  // fixed one (no EXIF date given, so addImageEntity falls back to its
  // sourceModifiedAt) — these two extra, directly-inserted rows give
  // fixed, known dates to assert against instead.
  beforeEach(() => {
    upsertEntity(db, { id: 'extra-a.jpg', roCrateId: crateEntityId('2025/03/10'), entityType: ENTITY_TYPE_IMAGE, name: 'extra-a.jpg', dateCreated: '2024-06-01T00:00:00.000Z' });
    upsertEntity(db, { id: 'extra-b.jpg', roCrateId: crateEntityId('2025/03/10'), entityType: ENTITY_TYPE_IMAGE, name: 'extra-b.jpg', dateCreated: '2024-06-15T00:00:00.000Z' });
  });

  it('requires a valid granularity', async () => {
    const res = await handleRequest({ method: 'GET', path: '/date-facet', query: { granularity: 'week' } });
    expect(res.status).toEqual(400);
  });

  it('requires year for granularity=month, and year+month for granularity=day', async () => {
    expect((await handleRequest({ method: 'GET', path: '/date-facet', query: { granularity: 'month' } })).status).toEqual(400);
    expect((await handleRequest({ method: 'GET', path: '/date-facet', query: { granularity: 'day', year: '2024' } })).status).toEqual(400);
  });

  it('lists years across the whole collection', async () => {
    const res = await handleRequest({ method: 'GET', path: '/date-facet', query: { granularity: 'year' } });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual(expect.arrayContaining([{ value: '2024', count: 2 }]));
  });

  it('lists months within a year', async () => {
    const res = await handleRequest({ method: 'GET', path: '/date-facet', query: { granularity: 'month', year: '2024' } });
    expect(JSON.parse(res.body)).toEqual([{ value: '06', count: 2 }]);
  });

  it('lists days within a year and month', async () => {
    const res = await handleRequest({ method: 'GET', path: '/date-facet', query: { granularity: 'day', year: '2024', month: '06' } });
    expect(JSON.parse(res.body)).toEqual(expect.arrayContaining([{ value: '01', count: 1 }, { value: '15', count: 1 }]));
  });
});

describe('GET /entities', () => {
  it('lists entities and applies a facet filter from the query string', async () => {
    const all = await handleRequest({ method: 'GET', path: '/entities', query: { entityType: ENTITY_TYPE_IMAGE } });
    expect(JSON.parse(all.body).total).toEqual(2);

    const filtered = await handleRequest({ method: 'GET', path: '/entities', query: { camera: 'Google Pixel 6a' } });
    const parsed = JSON.parse(filtered.body);
    expect(parsed.total).toEqual(1);
    expect(parsed.entities[0].id).toEqual('2025/03/10/photo.jpg');
  });

  it('includes each entity\'s own rating, so the grid can show it without a metadata request per tile', async () => {
    const res = await handleRequest({ method: 'GET', path: '/entities', query: { entityType: ENTITY_TYPE_IMAGE } });
    const parsed = JSON.parse(res.body);
    const photo = parsed.entities.find((e) => e.id === '2025/03/10/photo.jpg');
    const undated = parsed.entities.find((e) => e.id === '2025/03/10/undated.jpg');
    expect(photo.rating).toEqual(5);
    expect(undated.rating).toBeNull();
  });

  it('includes each entity\'s own title (falling back to its filename) and real caption', async () => {
    const res = await handleRequest({ method: 'GET', path: '/entities', query: { entityType: ENTITY_TYPE_IMAGE } });
    const parsed = JSON.parse(res.body);
    const photo = parsed.entities.find((e) => e.id === '2025/03/10/photo.jpg');
    const undated = parsed.entities.find((e) => e.id === '2025/03/10/undated.jpg');
    expect(photo.title).toEqual('photo.jpg'); // no ObjectName in its EXIF, so falls back to the filename
    expect(photo.description).toEqual('A heron at the lake');
    expect(undated.description).toBeUndefined();
  });

  it('filters by a keyword facet from the query string', async () => {
    const res = await handleRequest({ method: 'GET', path: '/entities', query: { keyword: 'Bird' } });
    const parsed = JSON.parse(res.body);
    expect(parsed.total).toEqual(1);
    expect(parsed.entities[0].id).toEqual('2025/03/10/photo.jpg');
  });

  it('filters by a rating facet from the query string', async () => {
    const res = await handleRequest({ method: 'GET', path: '/entities', query: { rating: '5' } });
    const parsed = JSON.parse(res.body);
    expect(parsed.total).toEqual(1);
    expect(parsed.entities[0].id).toEqual('2025/03/10/photo.jpg');
  });

  it('filters by people and pets as separate facets from the query string', async () => {
    const byPerson = await handleRequest({ method: 'GET', path: '/entities', query: { people: 'Peter Malcolm Sefton' } });
    expect(JSON.parse(byPerson.body).total).toEqual(1);

    const byPet = await handleRequest({ method: 'GET', path: '/entities', query: { pets: 'Rex' } });
    expect(JSON.parse(byPet.body).total).toEqual(1);

    const wrongPet = await handleRequest({ method: 'GET', path: '/entities', query: { pets: 'Peter Malcolm Sefton' } });
    expect(JSON.parse(wrongPet.body).total).toEqual(0);
  });
});

describe('GET /entity/{id}', () => {
  it('returns a single entity, percent-decoding the id', async () => {
    const res = await handleRequest({ method: 'GET', path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}` });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body).id).toEqual('2025/03/10/photo.jpg');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await handleRequest({ method: 'GET', path: `/entity/${encodeURIComponent('nope.jpg')}` });
    expect(res.status).toEqual(404);
  });

  it('resolves a Person entity, recorded once in the index despite being duplicated into every crate that depicts them', async () => {
    const res = await handleRequest({ method: 'GET', path: `/entity/${encodeURIComponent(personEntityId('Peter Malcolm Sefton'))}` });
    expect(res.status).toEqual(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.entityType).toEqual(ENTITY_TYPE_PERSON);
    expect(parsed.name).toEqual('Peter Malcolm Sefton');
  });
});

describe('GET /entity/{id}/metadata', () => {
  it('returns the entity\'s full, resolved RO-Crate JSON-LD document', async () => {
    const res = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(res.status).toEqual(200);
    expect(res.headers['Content-Type']).toEqual('application/ld+json');
    const parsed = JSON.parse(res.body);
    expect(parsed['@id']).toEqual('photo.jpg');
    // The outer entity's own properties are resolved and array-wrapped
    // (per array: true); a nested entity reached through a reference,
    // such as each exifData element here, keeps its own plain (non
    // array-wrapped) shape, since only one level is resolved.
    const exifNames = parsed.exifData.map((pv) => pv.name);
    expect(exifNames).toEqual(expect.arrayContaining(['Make', 'Model', 'LensModel']));
  });
});

describe('GET /entity/{id}/thumbnail', () => {
  it('serves the thumbnail bytes for an entity that has one', async () => {
    const res = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/thumbnail`,
    });
    expect(res.status).toEqual(200);
    expect(res.headers['Content-Type']).toEqual('image/jpeg');
    expect(new TextDecoder().decode(res.body)).toEqual('fake thumbnail bytes');
  });

  it('returns 404 for an entity with no thumbnail', async () => {
    const res = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/undated.jpg')}/thumbnail`,
    });
    expect(res.status).toEqual(404);
  });
});

describe('GET /files and GET /file/{id}', () => {
  it('lists a file for an entity, and serves its actual bytes with the right content type', async () => {
    const listRes = await handleRequest({ method: 'GET', path: '/files', query: { entityId: '2025/03/10/photo.jpg' } });
    const listed = JSON.parse(listRes.body);
    expect(listed.total).toEqual(1);
    expect(listed.files[0].mediaType).toEqual('image/jpeg');

    const fileRes = await handleRequest({ method: 'GET', path: `/file/${encodeURIComponent('2025/03/10/photo.jpg')}` });
    expect(fileRes.status).toEqual(200);
    expect(fileRes.headers['Content-Type']).toEqual('image/jpeg');
    expect(new TextDecoder().decode(fileRes.body)).toEqual('fake jpeg bytes');
  });

  it('requires entityId on /files', async () => {
    const res = await handleRequest({ method: 'GET', path: '/files' });
    expect(res.status).toEqual(400);
  });
});

describe('GET /ro-crates and GET /ro-crate/{id}', () => {
  it('lists RO-Crates and materialises entity ids for a single one', async () => {
    const listRes = await handleRequest({ method: 'GET', path: '/ro-crates' });
    expect(JSON.parse(listRes.body).total).toEqual(2);

    const subCrateId = crateEntityId('2025/03/10');
    const detailRes = await handleRequest({ method: 'GET', path: `/ro-crate/${encodeURIComponent(subCrateId)}` });
    const detail = JSON.parse(detailRes.body);
    expect(detail.entityIds).toEqual(expect.arrayContaining([subCrateId, '2025/03/10/photo.jpg', '2025/03/10/undated.jpg']));
  });

  it('serves a RO-Crate\'s metadata document verbatim', async () => {
    const subCrateId = crateEntityId('2025/03/10');
    const res = await handleRequest({ method: 'GET', path: `/ro-crate/${encodeURIComponent(subCrateId)}/metadata` });
    expect(res.status).toEqual(200);
    const parsed = JSON.parse(new TextDecoder().decode(res.body));
    expect(parsed['@graph'].some((e) => e['@id'] === 'photo.jpg')).toBe(true);
  });
});

describe('POST /search', () => {
  it('returns matching entities and requested facet counts', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/search',
      body: { filters: { entityType: ENTITY_TYPE_IMAGE }, facets: ['camera', 'year'] },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.total).toEqual(2);
    expect(parsed.facets.camera).toEqual(expect.arrayContaining([{ name: 'Google Pixel 6a', count: 1 }]));
    expect(parsed.facets.lens).toBeUndefined(); // not requested
  });

  it('computes keyword facet counts, since one entity can have several values for it', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/search',
      body: { filters: { entityType: ENTITY_TYPE_IMAGE }, facets: ['keyword'] },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.facets.keyword.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Background', count: 1 },
      { name: 'Bird', count: 1 },
    ]);
  });

  it('computes people and pets facet counts as separate facets', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/search',
      body: { filters: { entityType: ENTITY_TYPE_IMAGE }, facets: ['people', 'pets'] },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.facets.people).toEqual([{ name: 'Peter Malcolm Sefton', count: 1 }]);
    expect(parsed.facets.pets).toEqual([{ name: 'Rex', count: 1 }]);
  });

  it('rejects an unsupported facet name', async () => {
    const res = await handleRequest({ method: 'POST', path: '/search', body: { facets: ['not-a-facet'] } });
    expect(res.status).toEqual(400);
  });
});

describe('POST /edit/keywords', () => {
  it('adds a keyword, reflected immediately in the crate metadata and the keyword facet', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/edit/keywords',
      body: { ids: ['2025/03/10/photo.jpg'], add: ['Sunset'] },
    });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual({ updated: ['2025/03/10/photo.jpg'], errors: [] });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).keywords.sort()).toEqual(['Background', 'Bird', 'Sunset']);

    const searchRes = await handleRequest({ method: 'POST', path: '/search', body: { facets: ['keyword'] } });
    expect(JSON.parse(searchRes.body).facets.keyword).toEqual(expect.arrayContaining([{ name: 'Sunset', count: 1 }]));
  });

  it('removes a keyword', async () => {
    await handleRequest({ method: 'POST', path: '/edit/keywords', body: { ids: ['2025/03/10/photo.jpg'], remove: ['Bird'] } });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).keywords).toEqual(['Background']);
  });

  it('adds a fresh keyword to an image with none yet', async () => {
    await handleRequest({ method: 'POST', path: '/edit/keywords', body: { ids: ['2025/03/10/undated.jpg'], add: ['New'] } });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/undated.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).keywords).toEqual(['New']);
  });

  it('reports an unknown id as an error rather than failing the whole request', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/edit/keywords',
      body: { ids: ['2025/03/10/photo.jpg', 'nope.jpg'], add: ['Sunset'] },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.updated).toEqual(['2025/03/10/photo.jpg']);
    expect(parsed.errors).toEqual([{ id: 'nope.jpg', message: 'Not found' }]);
  });
});

describe('POST /edit/rating', () => {
  it('sets a rating, reflected immediately in the crate metadata and the rating facet', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/edit/rating',
      body: { ids: ['2025/03/10/undated.jpg'], rating: 3 },
    });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual({ updated: ['2025/03/10/undated.jpg'], errors: [] });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/undated.jpg')}/metadata`,
    });
    // rating is a scalar-assigned property, so it comes back array-wrapped
    // at this outer level (see the array: true / link: true note in
    // crateBuilder.js) — same as every other own property here.
    expect(JSON.parse(metadataRes.body).rating).toEqual([3]);

    const searchRes = await handleRequest({ method: 'POST', path: '/search', body: { facets: ['rating'] } });
    expect(JSON.parse(searchRes.body).facets.rating).toEqual(expect.arrayContaining([{ name: '3', count: 1 }]));
  });

  it('clears a rating when given null', async () => {
    await handleRequest({ method: 'POST', path: '/edit/rating', body: { ids: ['2025/03/10/photo.jpg'], rating: null } });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).rating).toBeUndefined();
  });

  it('rejects a rating outside 1-5', async () => {
    const res = await handleRequest({ method: 'POST', path: '/edit/rating', body: { ids: ['2025/03/10/photo.jpg'], rating: 6 } });
    expect(res.status).toEqual(400);
  });

  it('does not keep serving a stale reading from before the edit, once something has already read this entity\'s metadata', async () => {
    // Regression: /entity/{id}/metadata resolves a crate through a cache
    // kept for the life of the handler (see loadEntityFromCrate), to
    // avoid re-parsing the same crate file for every one of its
    // entities. An edit writes through a separate, short-lived cache of
    // its own — without also updating the long-lived one, a read that
    // happened to run before the edit would keep being served forever
    // after, since nothing would ever tell it the file changed underneath it.
    const before = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(before.body).rating).toEqual([5]);

    await handleRequest({ method: 'POST', path: '/edit/rating', body: { ids: ['2025/03/10/photo.jpg'], rating: 2 } });

    const after = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(after.body).rating).toEqual([2]);
  });

  it('serializes concurrent edits to different images in the same crate directory, so neither one\'s change is lost', async () => {
    // Regression test for a real bug found in the face-recognition
    // handler with the identical shape: every /edit/* route here is also
    // a read-the-crate-then-write-the-whole-thing-back operation. Two
    // edits to different images in the SAME crate directory, fired
    // without awaiting one before the other, can each read the same
    // "before" state, and whichever finishes saving last silently
    // discards the other's change — confirmed against a real collection
    // for the faces handler's /confirm; this handler's own /edit/*
    // routes share the exact same shape and needed the same fix
    // (serializeWrites, see writeQueue.js).
    const slowFsAdapter = {
      ...createNodeFsAdapter(currentRoot),
      readFile: async (relPath) => {
        if (relPath.endsWith(CRATE_FILE_NAME)) await new Promise((resolve) => setTimeout(resolve, 20));
        return createNodeFsAdapter(currentRoot).readFile(relPath);
      },
    };
    const slowHandler = createHandler({ store: db, fsAdapter: slowFsAdapter });

    await Promise.all([
      slowHandler({ method: 'POST', path: '/edit/rating', body: { ids: ['2025/03/10/photo.jpg'], rating: 4 } }),
      slowHandler({ method: 'POST', path: '/edit/rating', body: { ids: ['2025/03/10/undated.jpg'], rating: 2 } }),
    ]);

    const photoMeta = await slowHandler({ method: 'GET', path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata` });
    const undatedMeta = await slowHandler({ method: 'GET', path: `/entity/${encodeURIComponent('2025/03/10/undated.jpg')}/metadata` });
    expect(JSON.parse(photoMeta.body).rating).toEqual([4]);
    expect(JSON.parse(undatedMeta.body).rating).toEqual([2]);
  });
});

describe('POST /edit/title', () => {
  it('sets a title, reflected immediately in the crate metadata and the entity listing', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/edit/title',
      body: { ids: ['2025/03/10/photo.jpg'], title: 'A better title' },
    });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual({ updated: ['2025/03/10/photo.jpg'], errors: [] });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).title).toEqual(['A better title']);

    const listRes = await handleRequest({ method: 'GET', path: '/entities', query: { entityType: ENTITY_TYPE_IMAGE } });
    const photo = JSON.parse(listRes.body).entities.find((e) => e.id === '2025/03/10/photo.jpg');
    expect(photo.title).toEqual('A better title');
  });

  it('falls back to the filename rather than an empty title when cleared', async () => {
    await handleRequest({ method: 'POST', path: '/edit/title', body: { ids: ['2025/03/10/photo.jpg'], title: '' } });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).title).toEqual(['photo.jpg']);
  });

  it('reports an unknown id as an error rather than failing the whole request', async () => {
    const res = await handleRequest({ method: 'POST', path: '/edit/title', body: { ids: ['nope.jpg'], title: 'X' } });
    const parsed = JSON.parse(res.body);
    expect(parsed.updated).toEqual([]);
    expect(parsed.errors).toEqual([{ id: 'nope.jpg', message: 'Not found' }]);
  });
});

describe('POST /edit/description', () => {
  it('sets a description, reflected immediately in the crate metadata and the entity listing', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/edit/description',
      body: { ids: ['2025/03/10/undated.jpg'], description: 'A quiet morning' },
    });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual({ updated: ['2025/03/10/undated.jpg'], errors: [] });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/undated.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).description).toEqual(['A quiet morning']);

    const listRes = await handleRequest({ method: 'GET', path: '/entities', query: { entityType: ENTITY_TYPE_IMAGE } });
    const undated = JSON.parse(listRes.body).entities.find((e) => e.id === '2025/03/10/undated.jpg');
    expect(undated.description).toEqual('A quiet morning');
  });

  it('clears a description when given an empty string, rather than leaving it stale', async () => {
    await handleRequest({ method: 'POST', path: '/edit/description', body: { ids: ['2025/03/10/photo.jpg'], description: '' } });

    const metadataRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}/metadata`,
    });
    expect(JSON.parse(metadataRes.body).description).toBeUndefined();
  });
});

describe('POST /edit/delete', () => {
  it('moves the file to trash, removes it from the crate and index, but keeps the Person/Pet entities it depicted', async () => {
    const res = await handleRequest({ method: 'POST', path: '/edit/delete', body: { ids: ['2025/03/10/photo.jpg'] } });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual({ updated: ['2025/03/10/photo.jpg'], errors: [] });

    const entityRes = await handleRequest({ method: 'GET', path: `/entity/${encodeURIComponent('2025/03/10/photo.jpg')}` });
    expect(entityRes.status).toEqual(404);

    const fsAdapter = createNodeFsAdapter(currentRoot);
    expect(await fsAdapter.exists('2025/03/10/photo.jpg')).toBe(false);
    expect(await fsAdapter.exists('_rocphotos/trash/2025/03/10/photo.jpg')).toBe(true);
    expect(await fsAdapter.exists('2025/03/10/thumbnails/photo.jpg.thumb.jpg')).toBe(false);

    const cratePath = '2025/03/10/ro-crate-metadata.json';
    const crateJson = JSON.parse(new TextDecoder().decode(await fsAdapter.readFile(cratePath)));
    expect(crateJson['@graph'].some((e) => e['@id'] === 'photo.jpg')).toBe(false);

    const personRes = await handleRequest({
      method: 'GET',
      path: `/entity/${encodeURIComponent(personEntityId('Peter Malcolm Sefton'))}`,
    });
    expect(personRes.status).toEqual(200);
  });

  it('reports an unknown id as an error rather than failing the whole request', async () => {
    const res = await handleRequest({ method: 'POST', path: '/edit/delete', body: { ids: ['nope.jpg'] } });
    const parsed = JSON.parse(res.body);
    expect(parsed.updated).toEqual([]);
    expect(parsed.errors).toEqual([{ id: 'nope.jpg', message: 'Not found' }]);
  });
});

describe('unmatched routes', () => {
  it('returns 404', async () => {
    const res = await handleRequest({ method: 'GET', path: '/nonexistent' });
    expect(res.status).toEqual(404);
  });
});

describe('Albums', () => {
  it('creates an album, written into the root crate as an ImageGallery entity', async () => {
    const res = await handleRequest({
      method: 'POST',
      path: '/albums',
      body: { name: 'Road Trip 2025', description: 'Driving up the coast' },
    });
    expect(res.status).toEqual(200);
    const album = JSON.parse(res.body);
    expect(album.name).toEqual('Road Trip 2025');
    expect(album.description).toEqual('Driving up the coast');

    // Reflected immediately in the root crate file on disk, the same way
    // an edited image's crate is (see /edit/keywords above) — not only in
    // the index.
    const rootCrateJson = new TextDecoder().decode(await createNodeFsAdapter(currentRoot).readFile(CRATE_FILE_NAME));
    const rootGraph = JSON.parse(rootCrateJson)['@graph'];
    const albumNode = rootGraph.find((entity) => entity['@id'] === album.id);
    expect(albumNode).toMatchObject({ '@type': 'ImageGallery', name: 'Road Trip 2025', description: 'Driving up the coast' });
  });

  it('rejects creating an album with a blank name', async () => {
    const res = await handleRequest({ method: 'POST', path: '/albums', body: { name: '   ' } });
    expect(res.status).toEqual(400);
  });

  it('updates an existing album\'s description rather than creating a second one when the name matches', async () => {
    const first = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Road Trip' } })).body);
    const second = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Road Trip', description: 'Updated' } })).body);
    expect(second.id).toEqual(first.id);

    const listRes = await handleRequest({ method: 'GET', path: '/albums' });
    const albums = JSON.parse(listRes.body).albums;
    expect(albums.filter((a) => a.id === first.id)).toHaveLength(1);
    expect(albums.find((a) => a.id === first.id).description).toEqual('Updated');
  });

  it('lists albums filtered by a name search', async () => {
    await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Road Trip 2025' } });
    await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Family Reunion' } });

    const res = await handleRequest({ method: 'GET', path: '/albums', query: { q: 'road' } });
    expect(JSON.parse(res.body).albums.map((a) => a.name)).toEqual(['Road Trip 2025']);
  });

  it('adds images to an album and returns them resolved, in order, from GET /albums/{id}', async () => {
    const album = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Favourites' } })).body);

    const addRes = await handleRequest({
      method: 'POST',
      path: `/albums/${encodeURIComponent(album.id)}/add`,
      body: { imageIds: ['2025/03/10/photo.jpg', '2025/03/10/undated.jpg'] },
    });
    expect(JSON.parse(addRes.body)).toEqual({ added: 2, errors: [] });

    const detailRes = await handleRequest({ method: 'GET', path: `/albums/${encodeURIComponent(album.id)}` });
    const detail = JSON.parse(detailRes.body);
    expect(detail.members.map((m) => m.id)).toEqual(['2025/03/10/photo.jpg', '2025/03/10/undated.jpg']);

    // hasPart holds a proxy per member (`<albumId>#item-<n>`), not the
    // real image directly — each one a prov:specializationOf the real
    // image, so an image's appearance in this album could later carry
    // its own name/description without touching the real image's own
    // entity (not yet exposed through any route, but this is the data
    // model it needs).
    const rootCrateJson = new TextDecoder().decode(await createNodeFsAdapter(currentRoot).readFile(CRATE_FILE_NAME));
    const graph = JSON.parse(rootCrateJson)['@graph'];
    const albumNode = graph.find((entity) => entity['@id'] === album.id);
    expect(albumNode.hasPart.map((ref) => ref['@id'])).toEqual([`${album.id}#item-0`, `${album.id}#item-1`]);

    const proxy0 = graph.find((entity) => entity['@id'] === `${album.id}#item-0`);
    expect(proxy0).toMatchObject({ '@type': 'ImageObject', 'prov:specializationOf': { '@id': '2025/03/10/photo.jpg' } });
    const proxy1 = graph.find((entity) => entity['@id'] === `${album.id}#item-1`);
    expect(proxy1).toMatchObject({ '@type': 'ImageObject', 'prov:specializationOf': { '@id': '2025/03/10/undated.jpg' } });
  });

  it('reports an unknown image id as an error without failing the rest of the batch', async () => {
    const album = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Favourites' } })).body);
    const res = await handleRequest({
      method: 'POST',
      path: `/albums/${encodeURIComponent(album.id)}/add`,
      body: { imageIds: ['2025/03/10/photo.jpg', 'nope.jpg'] },
    });
    expect(JSON.parse(res.body)).toEqual({ added: 1, errors: [{ id: 'nope.jpg', message: 'Not found' }] });
  });

  it('404s adding to an unknown album', async () => {
    const res = await handleRequest({ method: 'POST', path: '/albums/nope/add', body: { imageIds: [] } });
    expect(res.status).toEqual(404);
  });

  it('404s fetching an unknown album', async () => {
    const res = await handleRequest({ method: 'GET', path: '/albums/nope' });
    expect(res.status).toEqual(404);
  });

  it('makes album membership filterable and combinable with other facets, like people/pets already are', async () => {
    const album = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Road Trip' } })).body);
    await handleRequest({
      method: 'POST',
      path: `/albums/${encodeURIComponent(album.id)}/add`,
      body: { imageIds: ['2025/03/10/photo.jpg'] },
    });

    const res = await handleRequest({
      method: 'POST',
      path: '/search',
      body: { filters: { albums: 'Road Trip' }, facets: ['albums'] },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.entities.map((e) => e.id)).toEqual(['2025/03/10/photo.jpg']);
    expect(parsed.facets.albums).toEqual([{ name: 'Road Trip', count: 1 }]);

    // Combined with another active facet (camera) — photo.jpg has one,
    // undated.jpg (never added to the album) does not.
    const combined = await handleRequest({
      method: 'POST',
      path: '/search',
      body: { filters: { albums: 'Road Trip', camera: 'Google Pixel 6a' } },
    });
    expect(JSON.parse(combined.body).entities.map((e) => e.id)).toEqual(['2025/03/10/photo.jpg']);

    const mismatched = await handleRequest({
      method: 'POST',
      path: '/search',
      body: { filters: { albums: 'Road Trip', camera: 'Canon EOS R5' } },
    });
    expect(JSON.parse(mismatched.body).entities).toEqual([]);
  });

  it('exports an album\'s member files into _exports/<album>, preserving each one\'s collection-relative path', async () => {
    const album = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Road Trip 2025' } })).body);
    await handleRequest({
      method: 'POST',
      path: `/albums/${encodeURIComponent(album.id)}/add`,
      body: { imageIds: ['2025/03/10/photo.jpg', '2025/03/10/undated.jpg'] },
    });

    const res = await handleRequest({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/export` });
    expect(res.status).toEqual(200);
    const result = JSON.parse(res.body);
    expect(result).toEqual({ destDir: '_exports/RoadTrip2025', exported: 2, errors: [], metadata: null });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    expect(await fsAdapter.exists('_exports/RoadTrip2025/2025/03/10/photo.jpg')).toBe(true);
    expect(await fsAdapter.exists('_exports/RoadTrip2025/2025/03/10/undated.jpg')).toBe(true);
    expect(await fsAdapter.readFile('_exports/RoadTrip2025/2025/03/10/photo.jpg')).toEqual(await fsAdapter.readFile('2025/03/10/photo.jpg'));
  });

  it('404s exporting an unknown album', async () => {
    const res = await handleRequest({ method: 'POST', path: '/albums/nope/export' });
    expect(res.status).toEqual(404);
  });

  it('writes each exported copy\'s metadata when the collection asked for it', async () => {
    const fsAdapter = createNodeFsAdapter(currentRoot);
    await saveConfig(fsAdapter, { exportWithMetadata: true });
    const written = [];
    const withMetadata = createHandler({
      store: db,
      fsAdapter,
      writeImageMetadata: async (absolutePath, metadata) => written.push({ absolutePath, metadata }),
    });

    const album = JSON.parse((await withMetadata({ method: 'POST', path: '/albums', body: { name: 'Road Trip 2025' } })).body);
    await withMetadata({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/add`, body: { imageIds: ['2025/03/10/photo.jpg'] } });
    const res = await withMetadata({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/export` });

    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body).metadata).toEqual({ written: 1 });
    expect(written).toHaveLength(1);
    expect(written[0].absolutePath).toEqual(`${currentRoot}/_exports/RoadTrip2025/2025/03/10/photo.jpg`);
    // Straight from the crate's own record, including the regions the
    // index only ever holds the names of.
    expect(written[0].metadata.description).toEqual('A heron at the lake');
    expect(written[0].metadata.keywords).toEqual(['Bird', 'Background']);
    expect(written[0].metadata.regions.map((region) => region.name)).toEqual(['Peter Malcolm Sefton', 'Rex']);
  });

  it('leaves exported copies alone when the collection did not ask for metadata', async () => {
    const fsAdapter = createNodeFsAdapter(currentRoot);
    const written = [];
    const withMetadata = createHandler({
      store: db,
      fsAdapter,
      writeImageMetadata: async (...args) => written.push(args),
    });

    const album = JSON.parse((await withMetadata({ method: 'POST', path: '/albums', body: { name: 'Road Trip 2025' } })).body);
    await withMetadata({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/add`, body: { imageIds: ['2025/03/10/photo.jpg'] } });
    const res = await withMetadata({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/export` });

    expect(JSON.parse(res.body).metadata).toBeNull();
    expect(written).toEqual([]);
  });

  it('exports the files anyway, saying what it could not do, when metadata is asked for but exiftool is not available', async () => {
    const fsAdapter = createNodeFsAdapter(currentRoot);
    await saveConfig(fsAdapter, { exportWithMetadata: true });

    const album = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Road Trip 2025' } })).body);
    await handleRequest({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/add`, body: { imageIds: ['2025/03/10/photo.jpg'] } });
    const res = await handleRequest({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/export` });

    expect(res.status).toEqual(200);
    const result = JSON.parse(res.body);
    expect(result.exported).toEqual(1);
    expect(result.metadata.unsupported).toMatch(/exiftool/);
    expect(await fsAdapter.exists('_exports/RoadTrip2025/2025/03/10/photo.jpg')).toBe(true);
  });

  it('exports to a configured absolute path instead, through the adapter the run mode supplies for it', async () => {
    const fsAdapter = createNodeFsAdapter(currentRoot);
    await setExportPathSetting(fsAdapter, '/somewhere/else');
    const elsewhere = await createFixtureTree({});
    const withAbsoluteExports = createHandler({
      store: db,
      fsAdapter,
      createAbsoluteFsAdapter: (configuredPath) => {
        expect(configuredPath).toEqual('/somewhere/else');
        return createNodeFsAdapter(elsewhere);
      },
    });

    const album = JSON.parse((await withAbsoluteExports({ method: 'POST', path: '/albums', body: { name: 'Road Trip 2025' } })).body);
    await withAbsoluteExports({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/add`, body: { imageIds: ['2025/03/10/photo.jpg'] } });
    const res = await withAbsoluteExports({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/export` });

    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual({ destDir: '/somewhere/else/RoadTrip2025', exported: 1, errors: [], metadata: null });
    const destFsAdapter = createNodeFsAdapter(elsewhere);
    expect(await destFsAdapter.exists('RoadTrip2025/2025/03/10/photo.jpg')).toBe(true);
    // Nothing landed in the collection's own _exports/ this time.
    expect(await fsAdapter.exists('_exports')).toBe(false);
    await removeFixtureTree(elsewhere);
  });

  it('refuses an absolute export path in a run mode that cannot write outside the collection, rather than silently exporting elsewhere', async () => {
    const fsAdapter = createNodeFsAdapter(currentRoot);
    await setExportPathSetting(fsAdapter, '/somewhere/else');

    const album = JSON.parse((await handleRequest({ method: 'POST', path: '/albums', body: { name: 'Road Trip 2025' } })).body);
    await handleRequest({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/add`, body: { imageIds: ['2025/03/10/photo.jpg'] } });
    const res = await handleRequest({ method: 'POST', path: `/albums/${encodeURIComponent(album.id)}/export` });

    expect(res.status).toEqual(400);
    expect(JSON.parse(res.body).error).toMatch(/rocphotos serve/);
    expect(await fsAdapter.exists('_exports')).toBe(false);
  });
});
