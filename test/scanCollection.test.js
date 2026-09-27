import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { ensureSchema, getRoCrateById, searchEntities, ENTITY_TYPE_IMAGE } from '../src/core/db/store.js';
import { CRATE_FILE_NAME } from '../src/core/crateBuilder.js';
import { CONFIG_FILE_NAME } from '../src/core/config.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

vi.mock('../src/core/exif.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, extractExif: vi.fn() };
});
import { extractExif } from '../src/core/exif.js';
import { scanCollection, bootstrapCollection, readExistingCrateJson } from '../src/core/scanCollection.js';

const noopThumbnail = async () => ({ thumbnailPath: null, error: null });

let currentRoot = null;
let fsAdapter;
let db;

beforeEach(() => {
  extractExif.mockResolvedValue({ exif: null, error: null });
  db = openNodeSqlite(':memory:');
  ensureSchema(db);
});

afterEach(async () => {
  db.close();
  vi.clearAllMocks();
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('bootstrapCollection', () => {
  it('creates an empty root crate and a default config file when neither exists yet', async () => {
    currentRoot = await createFixtureTree({ '2024': { '01': { 'photo.jpg': '' } } });
    fsAdapter = createNodeFsAdapter(currentRoot);

    await bootstrapCollection({ fsAdapter, db, rootName: 'My Photos' });

    expect(await fsAdapter.exists(CRATE_FILE_NAME)).toBe(true);
    expect(await fsAdapter.exists(CONFIG_FILE_NAME)).toBe(true);
    const rootCrateJson = await readExistingCrateJson(fsAdapter, '');
    expect(JSON.parse(rootCrateJson)['@graph'].some((n) => n['@id'] === './')).toBe(true);
    expect(getRoCrateById(db, './')).toMatchObject({ path: '.', name: 'My Photos' });
  });

  it('is idempotent: does not overwrite an already-existing root crate or config', async () => {
    currentRoot = await createFixtureTree({
      [CRATE_FILE_NAME]: '{"@context": "https://w3id.org/ro/crate/1.2/context", "@graph": [{"@id": "ro-crate-metadata.json", "@type": "CreativeWork", "about": {"@id": "./"}}, {"@id": "./", "@type": "Dataset", "name": "Existing"}]}',
      [CONFIG_FILE_NAME]: '{"excludeDirectories": ["^custom"]}',
    });
    fsAdapter = createNodeFsAdapter(currentRoot);

    await bootstrapCollection({ fsAdapter, db, rootName: 'My Photos' });

    const rootCrateJson = await readExistingCrateJson(fsAdapter, '');
    expect(JSON.parse(rootCrateJson)['@graph'].find((n) => n['@id'] === './').name).toEqual('Existing');
    const config = JSON.parse(new TextDecoder().decode(await fsAdapter.readFile(CONFIG_FILE_NAME)));
    expect(config.excludeDirectories).toEqual(['^custom']);
  });
});

describe('scanCollection', () => {
  it('scans every sub-collection when subdirs is empty (the default, whole-collection behaviour)', async () => {
    currentRoot = await createFixtureTree({
      '2024': { '01': { 'photo.jpg': '' } },
      '2025': { '02': { 'photo.jpg': '' } },
    });
    fsAdapter = createNodeFsAdapter(currentRoot);
    await bootstrapCollection({ fsAdapter, db, rootName: 'Root' });

    const result = await scanCollection({ fsAdapter, db, rootName: 'Root', generateThumbnailFor: noopThumbnail });

    expect(result.skippedForSubdir).toEqual([]);
    expect(result.failedToLoad).toEqual([]);
    expect(searchEntities(db, { entityType: ENTITY_TYPE_IMAGE }, { limit: 10 })).toHaveLength(2);
  });

  it('leaves a sub-collection not matched by subdirs entirely untouched, not even read', async () => {
    currentRoot = await createFixtureTree({
      '2024': { '01': { 'photo.jpg': '' } },
      '2025': { '02': { 'photo.jpg': '' } },
    });
    fsAdapter = createNodeFsAdapter(currentRoot);
    await bootstrapCollection({ fsAdapter, db, rootName: 'Root' });

    const result = await scanCollection({ fsAdapter, db, rootName: 'Root', subdirs: ['2024'], generateThumbnailFor: noopThumbnail });

    expect(result.skippedForSubdir).toEqual(['2025/02']);
    expect(await fsAdapter.exists('2025/02/' + CRATE_FILE_NAME)).toBe(false);
    const images = searchEntities(db, { entityType: ENTITY_TYPE_IMAGE }, { limit: 10 });
    expect(images.map((i) => i.id)).toEqual(['2024/01/photo.jpg']);
  });

  it('reports (and skips, without touching) a sub-collection whose existing crate file is not a valid RO-Crate, without aborting the rest of the scan', async () => {
    currentRoot = await createFixtureTree({
      '2024': { '01': { 'photo.jpg': '' } },
      '2025': { '02': { 'photo.jpg': '', [CRATE_FILE_NAME]: '{"@graph": [{"@id": "not-a-descriptor"}]}' } },
    });
    fsAdapter = createNodeFsAdapter(currentRoot);
    await bootstrapCollection({ fsAdapter, db, rootName: 'Root' });
    const badCrateJsonBefore = await readExistingCrateJson(fsAdapter, '2025/02');

    const result = await scanCollection({ fsAdapter, db, rootName: 'Root', generateThumbnailFor: noopThumbnail });

    expect(result.failedToLoad).toEqual([{ path: '2025/02', message: expect.stringContaining('root dataset') }]);
    expect(await readExistingCrateJson(fsAdapter, '2025/02')).toEqual(badCrateJsonBefore);
    const images = searchEntities(db, { entityType: ENTITY_TYPE_IMAGE }, { limit: 10 });
    expect(images.map((i) => i.id)).toEqual(['2024/01/photo.jpg']);
  });

  it('still processes the root\'s own directly-contained images even when subdirs is given', async () => {
    currentRoot = await createFixtureTree({
      'loose.jpg': '',
      '2024': { '01': { 'photo.jpg': '' } },
    });
    fsAdapter = createNodeFsAdapter(currentRoot);
    await bootstrapCollection({ fsAdapter, db, rootName: 'Root' });

    await scanCollection({ fsAdapter, db, rootName: 'Root', subdirs: ['2024'], generateThumbnailFor: noopThumbnail });

    const images = searchEntities(db, { entityType: ENTITY_TYPE_IMAGE }, { limit: 10 }).map((i) => i.id);
    expect(images).toContain('2024/01/photo.jpg');
    expect(images).toContain('loose.jpg');
  });
});
