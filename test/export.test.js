import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { exportDirFor, exportFiles, resolveExportTarget, writeExportMetadata, isAbsoluteExportPath, EXPORTS_DIR_NAME } from '../src/core/export.js';
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

  it('writes through a separate destination adapter when one is given, reading from the collection as usual', async () => {
    currentRoot = await createFixtureTree({
      collection: { '2025': { '03': { '10': { 'photo.jpg': 'photo bytes' } } } },
      elsewhere: {},
    });
    const sourceFsAdapter = createNodeFsAdapter(`${currentRoot}/collection`);
    const destFsAdapter = createNodeFsAdapter(`${currentRoot}/elsewhere`);

    const result = await exportFiles(sourceFsAdapter, 'RoadTrip', ['2025/03/10/photo.jpg'], destFsAdapter);

    expect(result.exported).toEqual(['2025/03/10/photo.jpg']);
    expect(new TextDecoder().decode(await destFsAdapter.readFile('RoadTrip/2025/03/10/photo.jpg'))).toEqual('photo bytes');
    // Nothing was written into the collection itself.
    expect(await sourceFsAdapter.exists('RoadTrip')).toBe(false);
  });
});

describe('writeExportMetadata', () => {
  const record = {
    title: 'A Title',
    description: 'A caption',
    rating: 4,
    keywords: ['beach'],
    regions: [{ name: 'Jane Smith', type: 'Face', area: { x: 0.5, y: 0.4, w: 0.2, h: 0.2 } }],
    exifEntries: [{ name: 'ImageWidth', value: '4000' }, { name: 'ImageHeight', value: '3000' }],
  };

  it('writes each exported copy\'s own metadata, at its real path on disk', async () => {
    currentRoot = await createFixtureTree({ exports: { RoadTrip: { '2025': { 'photo.jpg': 'bytes' } } } });
    const destFsAdapter = createNodeFsAdapter(currentRoot);
    const calls = [];

    const result = await writeExportMetadata(
      destFsAdapter,
      'exports/RoadTrip',
      [{ relativePath: '2025/photo.jpg', record }],
      async (absolutePath, metadata) => calls.push({ absolutePath, metadata }),
    );

    expect(result).toEqual({ written: 1, unsupported: false, errors: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].absolutePath).toEqual(`${currentRoot}/exports/RoadTrip/2025/photo.jpg`);
    expect(calls[0].metadata).toEqual({
      regions: record.regions,
      keywords: ['beach'],
      title: 'A Title',
      description: 'A caption',
      rating: 4,
      imageWidth: 4000,
      imageHeight: 3000,
    });
  });

  it('reports itself unsupported, rather than throwing, with no exiftool wrapper to write through', async () => {
    currentRoot = await createFixtureTree({});
    const result = await writeExportMetadata(createNodeFsAdapter(currentRoot), 'exports', [{ relativePath: 'a.jpg', record }], null);
    expect(result).toEqual({ written: 0, unsupported: true, errors: [] });
  });

  it('reports itself unsupported when the destination adapter cannot say where a file really is', async () => {
    const browserLikeAdapter = { writeFile: async () => {}, readFile: async () => new Uint8Array() };
    const result = await writeExportMetadata(browserLikeAdapter, 'exports', [{ relativePath: 'a.jpg', record }], async () => {});
    expect(result).toEqual({ written: 0, unsupported: true, errors: [] });
  });

  it('reports a file whose metadata could not be written, and carries on with the rest', async () => {
    currentRoot = await createFixtureTree({});
    const result = await writeExportMetadata(
      createNodeFsAdapter(currentRoot),
      'exports',
      [{ relativePath: 'bad.jpg', record }, { relativePath: 'good.jpg', record }],
      async (absolutePath) => {
        if (absolutePath.endsWith('bad.jpg')) throw new Error('exiftool exploded');
      },
    );

    expect(result.written).toEqual(1);
    expect(result.errors).toEqual([{ id: 'bad.jpg', message: expect.stringContaining('exiftool exploded') }]);
  });
});

describe('isAbsoluteExportPath', () => {
  it.each(['/srv/exports', '~/Pictures/Exports', 'C:\\Exports', 'D:/Exports'])('treats %s as outside the collection', (exportPath) => {
    expect(isAbsoluteExportPath(exportPath)).toBe(true);
  });

  it.each(['exports', 'my/exports', '', null])('treats %s as not an absolute path', (exportPath) => {
    expect(isAbsoluteExportPath(exportPath)).toBe(false);
  });
});

describe('resolveExportTarget', () => {
  it('falls back to the built-in _exports/<album>/ when no export path is configured', () => {
    expect(resolveExportTarget('Road Trip', null)).toEqual({ absoluteBase: null, destDir: `${EXPORTS_DIR_NAME}/RoadTrip` });
  });

  it('puts the album directly under a configured absolute path, with no _exports level inside it', () => {
    expect(resolveExportTarget('Road Trip', '~/Pictures/Exports')).toEqual({ absoluteBase: '~/Pictures/Exports', destDir: 'RoadTrip' });
  });

  it('ignores a relative configured path, which no run mode treats as outside the collection', () => {
    expect(resolveExportTarget('Road Trip', 'somewhere')).toEqual({ absoluteBase: null, destDir: `${EXPORTS_DIR_NAME}/RoadTrip` });
  });
});
