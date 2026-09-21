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
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
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
    exif: { Make: 'Google', Model: 'Pixel 6a', LensModel: 'Pixel 6a back camera' },
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
    expect(JSON.parse(res.body).search.facets).toEqual(['camera', 'lens', 'keyword', 'year']);
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

  it('filters by a keyword facet from the query string', async () => {
    const res = await handleRequest({ method: 'GET', path: '/entities', query: { keyword: 'Bird' } });
    const parsed = JSON.parse(res.body);
    expect(parsed.total).toEqual(1);
    expect(parsed.entities[0].id).toEqual('2025/03/10/photo.jpg');
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

  it('rejects an unsupported facet name', async () => {
    const res = await handleRequest({ method: 'POST', path: '/search', body: { facets: ['not-a-facet'] } });
    expect(res.status).toEqual(400);
  });
});

describe('unmatched routes', () => {
  it('returns 404', async () => {
    const res = await handleRequest({ method: 'GET', path: '/nonexistent' });
    expect(res.status).toEqual(404);
  });
});
