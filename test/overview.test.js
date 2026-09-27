import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { buildOverview, saveOverview, loadOverview, OVERVIEW_FILE_NAME } from '../src/core/overview.js';
import { CRATE_FILE_NAME, loadOrCreateCrate, serializeCrate, addImageEntity } from '../src/core/crateBuilder.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';
import fs from 'node:fs/promises';
import path from 'node:path';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('buildOverview', () => {
  it('reports a sub-collection with no crate file yet as not-scanned', async () => {
    currentRoot = await createFixtureTree({
      '2024': { '01': { 'photo1.jpg': '', 'photo2.jpg': '' } },
    });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const overview = await buildOverview(fsAdapter);

    expect(overview.subCollections).toEqual([{ path: '2024/01', imageCount: 2, status: 'not-scanned' }]);
    expect(overview.generatedAt).toEqual(expect.any(String));
  });

  it('reports up-to-date when every image\'s recorded time already covers its current file mtime', async () => {
    currentRoot = await createFixtureTree({ '2024': { '01': { 'photo.jpg': '' } } });
    const imagePath = path.join(currentRoot, '2024', '01', 'photo.jpg');
    const { mtimeMs } = await fs.stat(imagePath);

    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', sourceModifiedAt: mtimeMs });
    await fs.writeFile(path.join(currentRoot, '2024', '01', CRATE_FILE_NAME), serializeCrate(crate));

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const overview = await buildOverview(fsAdapter);

    expect(overview.subCollections).toEqual([{ path: '2024/01', imageCount: 1, status: 'up-to-date' }]);
  });

  it('reports out-of-date when a file has changed since the crate recorded it', async () => {
    currentRoot = await createFixtureTree({ '2024': { '01': { 'photo.jpg': '' } } });
    const imagePath = path.join(currentRoot, '2024', '01', 'photo.jpg');

    const crate = loadOrCreateCrate(null);
    // Recorded as processed a long time ago, well before the fixture file's
    // real (current) modification time.
    addImageEntity(crate, { path: 'photo.jpg', sourceModifiedAt: new Date('2000-01-01').getTime() });
    await fs.writeFile(path.join(currentRoot, '2024', '01', CRATE_FILE_NAME), serializeCrate(crate));

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const overview = await buildOverview(fsAdapter);

    expect(overview.subCollections).toEqual([{ path: '2024/01', imageCount: 1, status: 'out-of-date' }]);
  });

  it('reports a crate with no recorded time at all for one of its images as out-of-date', async () => {
    currentRoot = await createFixtureTree({ '2024': { '01': { 'a.jpg': '', 'b.jpg': '' } } });

    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', sourceModifiedAt: Date.now() });
    // b.jpg was never processed at all (e.g. the crate predates it).
    await fs.writeFile(path.join(currentRoot, '2024', '01', CRATE_FILE_NAME), serializeCrate(crate));

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const overview = await buildOverview(fsAdapter);

    expect(overview.subCollections).toEqual([{ path: '2024/01', imageCount: 2, status: 'out-of-date' }]);
  });

  it('reports a sub-collection whose existing crate file is not a valid RO-Crate as invalid, without throwing', async () => {
    currentRoot = await createFixtureTree({
      '2024': { '01': { 'photo.jpg': '', [CRATE_FILE_NAME]: '{"@graph": [{"@id": "not-a-descriptor"}]}' } },
    });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const overview = await buildOverview(fsAdapter);

    expect(overview.subCollections).toEqual([{ path: '2024/01', imageCount: 1, status: 'invalid' }]);
  });

  it('reports each sub-collection independently', async () => {
    currentRoot = await createFixtureTree({
      '2024': { '01': { 'photo.jpg': '' } },
      '2025': { '02': { 'photo.jpg': '' } },
    });
    const imagePath = path.join(currentRoot, '2024', '01', 'photo.jpg');
    const { mtimeMs } = await fs.stat(imagePath);

    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', sourceModifiedAt: mtimeMs });
    await fs.writeFile(path.join(currentRoot, '2024', '01', CRATE_FILE_NAME), serializeCrate(crate));

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const overview = await buildOverview(fsAdapter);

    expect(overview.subCollections.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '2024/01', imageCount: 1, status: 'up-to-date' },
      { path: '2025/02', imageCount: 1, status: 'not-scanned' },
    ]);
  });
});

describe('saveOverview / loadOverview', () => {
  it('returns null when no overview has ever been saved', async () => {
    currentRoot = await createFixtureTree({ '2024': { '01': { 'photo.jpg': '' } } });
    const fsAdapter = createNodeFsAdapter(currentRoot);
    expect(await loadOverview(fsAdapter)).toBeNull();
  });

  it('round-trips a saved overview, and writes it under the documented file name', async () => {
    currentRoot = await createFixtureTree({ '2024': { '01': { 'photo.jpg': '' } } });
    const fsAdapter = createNodeFsAdapter(currentRoot);

    const overview = await buildOverview(fsAdapter);
    await saveOverview(fsAdapter, overview);

    expect(await fsAdapter.exists(OVERVIEW_FILE_NAME)).toBe(true);
    expect(await loadOverview(fsAdapter)).toEqual(overview);
  });
});

