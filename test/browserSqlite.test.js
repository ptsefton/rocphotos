import { describe, it, expect } from 'vitest';
import { openBrowserSqlite } from '../src/adapters/browserSqlite.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import {
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  setEntityFacetValues,
  searchEntities,
  countSearchResults,
  facetCounts,
  crateEntityId,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
} from '../src/core/db/store.js';
import { createHandler } from '../src/core/arocapi/handler.js';

// db/store.js and the AROCAPI handler are written against the abstract
// SqliteDriver shape (see nodeSqlite.js), not against node:sqlite
// specifically — these tests confirm the sql.js-backed driver satisfies
// that same contract well enough for the whole read/write/facet/search
// path to work identically, since it is what the browser SPA (which has
// no access to node:sqlite at all) must rely on.

describe('openBrowserSqlite: schema, CRUD, search, and facets', () => {
  it('creates the schema and supports the same queries db/store.js issues against node:sqlite', async () => {
    const { driver } = await openBrowserSqlite(null);
    ensureSchema(driver);

    const rootId = crateEntityId('');
    upsertRoCrate(driver, { id: rootId, path: '.', name: 'root' });
    upsertEntity(driver, { id: rootId, roCrateId: rootId, entityType: ENTITY_TYPE_COLLECTION, name: 'root' });

    upsertEntity(driver, {
      id: 'a.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'a.jpg', memberOf: rootId,
      dateCreated: '2025-03-10T00:00:00.000Z',
    });
    setEntityFacetValues(driver, 'a.jpg', 'camera', ['Google Pixel 6a']);
    setEntityFacetValues(driver, 'a.jpg', 'keyword', ['Bird', 'Background']);
    upsertFile(driver, { id: 'a.jpg', entityId: 'a.jpg', filename: 'a.jpg', mediaType: 'image/jpeg', size: 16, relativePath: 'a.jpg' });

    upsertEntity(driver, {
      id: 'b.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'b.jpg', memberOf: rootId,
      dateCreated: '2024-12-25T00:00:00.000Z',
    });
    setEntityFacetValues(driver, 'b.jpg', 'camera', ['Canon EOS R5']);

    const results = searchEntities(driver, { entityType: ENTITY_TYPE_IMAGE, camera: 'Google Pixel 6a' });
    expect(results.map((r) => r.id)).toEqual(['a.jpg']);
    expect(countSearchResults(driver, { entityType: ENTITY_TYPE_IMAGE })).toEqual(2);

    const counts = facetCounts(driver, 'keyword', {});
    expect(counts).toEqual(expect.arrayContaining([
      { value: 'Bird', count: 1 },
      { value: 'Background', count: 1 },
    ]));
  });

  it('serves AROCAPI requests identically to the node:sqlite-backed handler', async () => {
    const { driver } = await openBrowserSqlite(null);
    ensureSchema(driver);
    const rootId = crateEntityId('');
    upsertRoCrate(driver, { id: rootId, path: '.', name: 'root' });
    upsertEntity(driver, { id: rootId, roCrateId: rootId, entityType: ENTITY_TYPE_COLLECTION, name: 'root' });
    upsertEntity(driver, { id: 'a.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'a.jpg', memberOf: rootId });
    setEntityFacetValues(driver, 'a.jpg', 'rating', ['5']);

    const fsAdapter = { exists: async () => false, readFile: async () => new Uint8Array() };
    const handleRequest = createHandler({ store: driver, fsAdapter });

    const res = await handleRequest({ method: 'GET', path: '/entities', query: { rating: '5' } });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body).total).toEqual(1);
  });
});

describe('openBrowserSqlite: export/reopen round-trip', () => {
  it('persists data across an export and a fresh reopen from those bytes', async () => {
    const first = await openBrowserSqlite(null);
    ensureSchema(first.driver);
    const rootId = crateEntityId('');
    upsertRoCrate(first.driver, { id: rootId, path: '.', name: 'root' });
    upsertEntity(first.driver, { id: rootId, roCrateId: rootId, entityType: ENTITY_TYPE_COLLECTION, name: 'root' });
    const bytes = first.export();

    const second = await openBrowserSqlite(bytes);
    expect(second.driver.get('SELECT * FROM ro_crates WHERE id = ?', [rootId])).toMatchObject({ name: 'root' });
  });

  it('opens a real database file written by node:sqlite unmodified', async () => {
    const { createFixtureTree, removeFixtureTree } = await import('./helpers/tempDir.js');
    const path = (await import('node:path')).default;

    const root = await createFixtureTree({});
    const dbPath = path.join(root, 'index.sqlite');
    const nodeDriver = openNodeSqlite(dbPath);
    ensureSchema(nodeDriver);
    const rootId = crateEntityId('');
    upsertRoCrate(nodeDriver, { id: rootId, path: '.', name: 'from-node' });
    nodeDriver.close();

    const fs = await import('node:fs');
    const bytes = new Uint8Array(fs.readFileSync(dbPath));
    const { driver } = await openBrowserSqlite(bytes);
    expect(driver.get('SELECT * FROM ro_crates WHERE id = ?', [rootId])).toMatchObject({ name: 'from-node' });

    await removeFixtureTree(root);
  });
});
