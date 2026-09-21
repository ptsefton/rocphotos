import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { buildOverview, buildOverviewTree, saveOverview, loadOverview, OVERVIEW_FILE_NAME } from '../src/core/overview.js';
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

describe('buildOverviewTree', () => {
  it('nests crates under the plain directories above them, e.g. year then month', () => {
    const tree = buildOverviewTree([
      { path: '2024/01', imageCount: 2, status: 'up-to-date' },
      { path: '2024/02', imageCount: 5, status: 'not-scanned' },
      { path: '2025/03', imageCount: 9, status: 'out-of-date' },
    ]);

    expect(tree.isCrate).toBe(false);
    expect(tree.children.map((c) => c.name)).toEqual(['2024', '2025']);

    const year2024 = tree.children.find((c) => c.name === '2024');
    expect(year2024.isCrate).toBe(false);
    expect(year2024.children.map((c) => c.name)).toEqual(['01', '02']);

    const jan = year2024.children.find((c) => c.name === '01');
    expect(jan).toMatchObject({ isCrate: true, path: '2024/01', imageCount: 2, status: 'up-to-date' });
    expect(jan.children).toEqual([]);
  });

  it('places a crate several directories deep at the right nesting, e.g. year/month/day', () => {
    const tree = buildOverviewTree([{ path: '2024/02/01', imageCount: 3, status: 'up-to-date' }]);

    const day = tree.children[0].children[0].children[0];
    expect(day).toMatchObject({ path: '2024/02/01', name: '01', isCrate: true });
  });

  it('treats the root itself as a crate when the whole collection is flat (no sub-collections)', () => {
    const tree = buildOverviewTree([{ path: '', imageCount: 4, status: 'up-to-date' }]);

    expect(tree).toMatchObject({ isCrate: true, path: '', imageCount: 4, status: 'up-to-date' });
    expect(tree.children).toEqual([]);
  });

  it('sums each folder\'s summary over every crate nested beneath it, at every level', () => {
    const tree = buildOverviewTree([
      { path: '2024/01', imageCount: 2, status: 'up-to-date' },
      { path: '2024/02', imageCount: 5, status: 'not-scanned' },
      { path: '2025/03', imageCount: 9, status: 'out-of-date' },
    ]);

    expect(tree.summary).toEqual({ notScanned: 1, outOfDate: 1, upToDate: 1, imageCount: 16 });
    const year2024 = tree.children.find((c) => c.name === '2024');
    expect(year2024.summary).toEqual({ notScanned: 1, outOfDate: 0, upToDate: 1, imageCount: 7 });
  });

  it('gives a crate leaf a summary of just itself', () => {
    const tree = buildOverviewTree([{ path: '2024/01', imageCount: 2, status: 'out-of-date' }]);
    const jan = tree.children[0].children[0];
    expect(jan.summary).toEqual({ notScanned: 0, outOfDate: 1, upToDate: 0, imageCount: 2 });
  });

  it('returns an empty root with no children for an empty collection', () => {
    const tree = buildOverviewTree([]);
    expect(tree).toMatchObject({ isCrate: false, children: [] });
    expect(tree.summary).toEqual({ notScanned: 0, outOfDate: 0, upToDate: 0, imageCount: 0 });
  });
});
