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
} from '../src/core/db/store.js';
import { loadOrCreateCrate, serializeCrate, addImageEntity, addSubCrateReference } from '../src/core/crateBuilder.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

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

describe('GET /capabilities', () => {
  it('declares the supported facets', async () => {
    const res = await handleRequest({ method: 'GET', path: '/capabilities' });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body).search.facets).toEqual(['camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'year']);
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
