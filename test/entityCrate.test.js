import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { loadOrCreateCrate, serializeCrate, addImageEntity } from '../src/core/crateBuilder.js';
import { crateEntityId } from '../src/core/db/store.js';
import { loadEntityFromCrate } from '../src/core/entityCrate.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('loadEntityFromCrate', () => {
  it('resolves an image entity, including its EXIF PropertyValues, from the root crate', async () => {
    const rootCrate = loadOrCreateCrate(null);
    addImageEntity(rootCrate, { path: 'photo.jpg', exif: { Make: 'Google', Model: 'Pixel 6a' } });
    currentRoot = await createFixtureTree({ 'ro-crate-metadata.json': serializeCrate(rootCrate) });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const entity = await loadEntityFromCrate(fsAdapter, new Map(), crateEntityId(''), 'photo.jpg');

    expect(entity.name).toEqual(['photo.jpg']);
    const exifNames = entity.exifData.map((pv) => pv.name[0]);
    expect(exifNames).toEqual(expect.arrayContaining(['Make', 'Model']));
  });

  it('resolves an image entity from a sub-crate, converting the collection-relative id to the crate-relative one', async () => {
    const subCrate = loadOrCreateCrate(null);
    addImageEntity(subCrate, { path: 'photo.jpg', exif: { Make: 'Google' } });
    currentRoot = await createFixtureTree({
      '2025': { '03': { '10': { 'ro-crate-metadata.json': serializeCrate(subCrate) } } },
    });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const roCrateId = crateEntityId('2025/03/10');
    const entity = await loadEntityFromCrate(fsAdapter, new Map(), roCrateId, '2025/03/10/photo.jpg');

    expect(entity.name).toEqual(['photo.jpg']);
  });

  it('resolves a crate\'s own Collection entity via the root convention id', async () => {
    const subCrate = loadOrCreateCrate(null);
    subCrate.rootDataset.name = '2025/03/10';
    currentRoot = await createFixtureTree({
      '2025': { '03': { '10': { 'ro-crate-metadata.json': serializeCrate(subCrate) } } },
    });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const roCrateId = crateEntityId('2025/03/10');
    const entity = await loadEntityFromCrate(fsAdapter, new Map(), roCrateId, roCrateId);

    expect(entity['@id']).toEqual('./');
    expect(entity.name).toEqual(['2025/03/10']);
  });

  it('returns null when the entity does not exist in its crate', async () => {
    const subCrate = loadOrCreateCrate(null);
    currentRoot = await createFixtureTree({
      '2025': { '03': { '10': { 'ro-crate-metadata.json': serializeCrate(subCrate) } } },
    });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    const entity = await loadEntityFromCrate(fsAdapter, new Map(), crateEntityId('2025/03/10'), '2025/03/10/missing.jpg');

    expect(entity).toBeNull();
  });

  it('reuses a cached crate rather than reading the file again for a second entity in it', async () => {
    const subCrate = loadOrCreateCrate(null);
    addImageEntity(subCrate, { path: 'a.jpg' });
    addImageEntity(subCrate, { path: 'b.jpg' });
    currentRoot = await createFixtureTree({
      '2025': { '03': { '10': { 'ro-crate-metadata.json': serializeCrate(subCrate) } } },
    });

    const fsAdapter = createNodeFsAdapter(currentRoot);
    let readCount = 0;
    const countingAdapter = {
      ...fsAdapter,
      readFile: (...args) => {
        readCount += 1;
        return fsAdapter.readFile(...args);
      },
    };

    const cache = new Map();
    const roCrateId = crateEntityId('2025/03/10');
    await loadEntityFromCrate(countingAdapter, cache, roCrateId, '2025/03/10/a.jpg');
    await loadEntityFromCrate(countingAdapter, cache, roCrateId, '2025/03/10/b.jpg');

    expect(readCount).toEqual(1);
  });
});
