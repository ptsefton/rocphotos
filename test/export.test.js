import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { exportDirFor, exportFiles, EXPORTS_DIR_NAME } from '../src/core/export.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('exportDirFor', () => {
  it('slugs the album name into a stable directory under _exports', () => {
    expect(exportDirFor('Road Trip 2025')).toEqual(`${EXPORTS_DIR_NAME}/RoadTrip2025`);
  });

  it('always produces the same directory for the same name', () => {
    expect(exportDirFor('Road Trip')).toEqual(exportDirFor('Road Trip'));
  });
});

describe('exportFiles', () => {
  it('copies each file into the export directory, preserving its collection-relative path', async () => {
    currentRoot = await createFixtureTree({
      '2025': { '03': { '10': { 'photo.jpg': 'photo bytes' } } },
      '2024': { '12': { '25': { 'other.jpg': 'other bytes' } } },
    });
    const fsAdapter = createNodeFsAdapter(currentRoot);

    const result = await exportFiles(fsAdapter, 'exports/road-trip', ['2025/03/10/photo.jpg', '2024/12/25/other.jpg']);

    expect(result).toEqual({ exported: ['2025/03/10/photo.jpg', '2024/12/25/other.jpg'], errors: [] });
    expect(new TextDecoder().decode(await fsAdapter.readFile('exports/road-trip/2025/03/10/photo.jpg'))).toEqual('photo bytes');
    expect(new TextDecoder().decode(await fsAdapter.readFile('exports/road-trip/2024/12/25/other.jpg'))).toEqual('other bytes');
    // The originals are untouched — this is a copy, not a move.
    expect(await fsAdapter.exists('2025/03/10/photo.jpg')).toBe(true);
  });

  it('overwrites a file already at its export path, so re-running an export is always safe', async () => {
    currentRoot = await createFixtureTree({
      '2025': { '03': { '10': { 'photo.jpg': 'updated bytes' } } },
      exports: { 'road-trip': { '2025': { '03': { '10': { 'photo.jpg': 'stale bytes' } } } } },
    });
    const fsAdapter = createNodeFsAdapter(currentRoot);

    await exportFiles(fsAdapter, 'exports/road-trip', ['2025/03/10/photo.jpg']);

    expect(new TextDecoder().decode(await fsAdapter.readFile('exports/road-trip/2025/03/10/photo.jpg'))).toEqual('updated bytes');
  });

  it('attempts every file regardless of an earlier one failing, reporting failures rather than throwing', async () => {
    currentRoot = await createFixtureTree({ '2025': { '03': { '10': { 'photo.jpg': 'photo bytes' } } } });
    const fsAdapter = createNodeFsAdapter(currentRoot);

    const result = await exportFiles(fsAdapter, 'exports/road-trip', ['2025/03/10/missing.jpg', '2025/03/10/photo.jpg']);

    expect(result.exported).toEqual(['2025/03/10/photo.jpg']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toEqual('2025/03/10/missing.jpg');
  });
});
