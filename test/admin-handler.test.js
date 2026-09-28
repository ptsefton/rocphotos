import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { ensureSchema, searchEntities, ENTITY_TYPE_IMAGE } from '../src/core/db/store.js';
import { bootstrapCollection } from '../src/core/scanCollection.js';
import { createAdminHandler } from '../src/core/admin/handler.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';
import { PREVIEW_FILE_NAME } from '../src/core/htmlPreview.js';

vi.mock('../src/core/exif.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, extractExif: vi.fn() };
});
import { extractExif } from '../src/core/exif.js';

const noopThumbnail = async () => ({ thumbnailPath: null, error: null });

let currentRoot = null;
let fsAdapter;
let db;
let handleRequest;
let crateCache;

beforeEach(async () => {
  extractExif.mockResolvedValue({ exif: null, error: null });
  currentRoot = await createFixtureTree({
    '2024': { '01': { 'photo.jpg': '' } },
    '2025': { '02': { 'photo.jpg': '' } },
  });
  fsAdapter = createNodeFsAdapter(currentRoot);
  db = openNodeSqlite(':memory:');
  ensureSchema(db);
  await bootstrapCollection({ fsAdapter, db, rootName: 'Root' });
  crateCache = new Map();
  handleRequest = createAdminHandler({ db, fsAdapter, rootName: 'Root', crateCache, generateThumbnailFor: noopThumbnail });
});

afterEach(async () => {
  db.close();
  vi.clearAllMocks();
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('GET /overview', () => {
  it('reports every sub-collection as not-scanned on a fresh collection', async () => {
    const res = await handleRequest({ method: 'GET', path: '/overview' });
    expect(res.status).toEqual(200);
    const body = JSON.parse(res.body);
    expect(body.subCollections.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '2024/01', imageCount: 1, status: 'not-scanned' },
      { path: '2025/02', imageCount: 1, status: 'not-scanned' },
    ]);
  });

  it('reflects a scan already done this run, from the persisted overview, without a fresh directory walk being required', async () => {
    await handleRequest({ method: 'POST', path: '/scan', body: { subdirs: ['2024'] } });
    const res = await handleRequest({ method: 'GET', path: '/overview' });
    const body = JSON.parse(res.body);
    expect(body.subCollections.find((s) => s.path === '2024/01').status).toEqual('up-to-date');
  });
});

describe('POST /scan', () => {
  it('requires a non-empty subdirs array', async () => {
    const res = await handleRequest({ method: 'POST', path: '/scan', body: {} });
    expect(res.status).toEqual(400);
  });

  it('scans only the requested sub-collection and reports it', async () => {
    const res = await handleRequest({ method: 'POST', path: '/scan', body: { subdirs: ['2024'] } });
    expect(res.status).toEqual(200);
    const body = JSON.parse(res.body);
    expect(body.scanned).toEqual(1);
    expect(body.failedToLoad).toEqual([]);
    expect(body.overview.subCollections.find((s) => s.path === '2025/02').status).toEqual('not-scanned');
  });

  it('is reflected immediately in the shared db, without a restart', async () => {
    await handleRequest({ method: 'POST', path: '/scan', body: { subdirs: ['2024'] } });
    const images = searchEntities(db, { entityType: ENTITY_TYPE_IMAGE }, { limit: 10 });
    expect(images.map((i) => i.id)).toEqual(['2024/01/photo.jpg']);
  });

  it('clears the shared crate-read cache so stale metadata is never served after a scan', async () => {
    crateCache.set('2024/01/', { stale: true });
    await handleRequest({ method: 'POST', path: '/scan', body: { subdirs: ['2024'] } });
    expect(crateCache.size).toEqual(0);
  });

  it('reports (without failing the whole request) a sub-collection whose existing crate file is invalid', async () => {
    await fsAdapter.writeFile('2025/02/ro-crate-metadata.json', '{"@graph": [{"@id": "not-a-descriptor"}]}');
    const res = await handleRequest({ method: 'POST', path: '/scan', body: { subdirs: ['2024', '2025'] } });
    const body = JSON.parse(res.body);
    expect(body.scanned).toEqual(1);
    expect(body.failedToLoad).toEqual([{ path: '2025/02', message: expect.stringContaining('root dataset') }]);
  });
});

describe('POST /regenerate-previews', () => {
  it('rewrites every preview page from what is already indexed, without a rescan', async () => {
    await handleRequest({ method: 'POST', path: '/scan', body: { subdirs: ['2024'] } });
    await fsAdapter.deleteFile(`2024/01/${PREVIEW_FILE_NAME}`);

    const res = await handleRequest({ method: 'POST', path: '/regenerate-previews' });

    expect(res.status).toEqual(200);
    const body = JSON.parse(res.body);
    expect(body.written).toBeGreaterThanOrEqual(2); // the scanned sub-collection's, plus the root's
    expect(body.skipped).toEqual([]);
    expect(await fsAdapter.exists(`2024/01/${PREVIEW_FILE_NAME}`)).toBe(true);
  });
});

describe('GET/POST /config', () => {
  it('reports the default config for a fresh, un-configured collection', async () => {
    const res = await handleRequest({ method: 'GET', path: '/config' });
    expect(res.status).toEqual(200);
    expect(JSON.parse(res.body)).toEqual({
      excludeDirectories: ['^\\.'],
      excludeFiles: [],
      writeMetadataToFiles: false,
      exportPath: null,
      exportWithMetadata: false,
    });
  });

  it('saves and reflects every field back immediately', async () => {
    const saveRes = await handleRequest({
      method: 'POST',
      path: '/config',
      body: { excludeDirectories: ['^\\.', '^HTML'], excludeFiles: ['^Thumbs\\.db$'], writeMetadataToFiles: true, exportPath: '~/Pictures/Exports', exportWithMetadata: true },
    });
    expect(JSON.parse(saveRes.body)).toEqual({
      excludeDirectories: ['^\\.', '^HTML'],
      excludeFiles: ['^Thumbs\\.db$'],
      writeMetadataToFiles: true,
      exportPath: '~/Pictures/Exports',
      exportWithMetadata: true,
    });

    const getRes = await handleRequest({ method: 'GET', path: '/config' });
    expect(JSON.parse(getRes.body)).toEqual({
      excludeDirectories: ['^\\.', '^HTML'],
      excludeFiles: ['^Thumbs\\.db$'],
      writeMetadataToFiles: true,
      exportPath: '~/Pictures/Exports',
      exportWithMetadata: true,
    });
  });

  it('saving one field leaves the others already saved untouched', async () => {
    await handleRequest({ method: 'POST', path: '/config', body: { excludeDirectories: ['^\\.', '^HTML'] } });
    await handleRequest({ method: 'POST', path: '/config', body: { writeMetadataToFiles: true } });

    const res = await handleRequest({ method: 'GET', path: '/config' });
    expect(JSON.parse(res.body)).toEqual({
      excludeDirectories: ['^\\.', '^HTML'],
      excludeFiles: [],
      writeMetadataToFiles: true,
      exportPath: null,
      exportWithMetadata: false,
    });
  });

  it('rejects a relative export path, rather than saving one that would then be ignored at export time', async () => {
    const res = await handleRequest({ method: 'POST', path: '/config', body: { exportPath: 'somewhere/else' } });
    expect(res.status).toEqual(400);
    expect(JSON.parse(res.body).error).toMatch(/absolute path/);

    const getRes = await handleRequest({ method: 'GET', path: '/config' });
    expect(JSON.parse(getRes.body).exportPath).toBeNull();
  });

  it('clears the export path back to the default when saved blank', async () => {
    await handleRequest({ method: 'POST', path: '/config', body: { exportPath: '/tmp/exports' } });
    await handleRequest({ method: 'POST', path: '/config', body: { exportPath: '  ' } });

    const res = await handleRequest({ method: 'GET', path: '/config' });
    expect(JSON.parse(res.body).exportPath).toBeNull();
  });
});
