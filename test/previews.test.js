import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { collectPeopleForRootPreview, regeneratePreviews } from '../src/core/previews.js';
import { PREVIEW_FILE_NAME } from '../src/core/htmlPreview.js';
import {
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  setEntityFacetValues,
  crateEntityId,
  imageEntityId,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
} from '../src/core/db/store.js';
import { loadOrCreateCrate, serializeCrate, addImageEntity, CRATE_FILE_NAME } from '../src/core/crateBuilder.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;
let fsAdapter;
let db;

const subCrateId = crateEntityId('2025/03');

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

// A collection whose crates and index both already exist, as they would
// after a scan — regenerating previews never re-reads a photo, so no
// real image bytes are needed.
beforeEach(async () => {
  const subCrate = loadOrCreateCrate(null);
  subCrate.rootDataset.name = '2025/03';
  for (const [path, person] of [['a.jpg', 'Jane Smith'], ['b.jpg', 'Bob Jones']]) {
    addImageEntity(subCrate, {
      path,
      exif: { Regions: { RegionList: { Name: person, Type: 'Face', Area: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } } },
      thumbnailPath: `thumbnails/${path}.thumb.jpg`,
      sourceModifiedAt: Date.now(),
    });
  }

  currentRoot = await createFixtureTree({
    'ro-crate-metadata.json': serializeCrate(loadOrCreateCrate(null)),
    2025: { '03': { 'ro-crate-metadata.json': serializeCrate(subCrate), 'a.jpg': 'x', 'b.jpg': 'x' } },
  });

  fsAdapter = createNodeFsAdapter(currentRoot);
  db = openNodeSqlite(':memory:');
  ensureSchema(db);

  const rootId = crateEntityId('');
  upsertRoCrate(db, { id: rootId, path: '.', name: 'Photo Collection' });
  upsertEntity(db, { id: rootId, roCrateId: rootId, entityType: ENTITY_TYPE_COLLECTION, name: 'Photo Collection' });
  upsertRoCrate(db, { id: subCrateId, path: '2025/03', name: '2025/03' });
  upsertEntity(db, { id: subCrateId, roCrateId: subCrateId, entityType: ENTITY_TYPE_COLLECTION, name: '2025/03', memberOf: rootId });

  for (const [path, person] of [['a.jpg', 'Jane Smith'], ['b.jpg', 'Bob Jones']]) {
    const id = imageEntityId('2025/03', path);
    upsertEntity(db, { id, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: path, memberOf: subCrateId, dateCreated: '2025-03-10T00:00:00.000Z' });
    setEntityFacetValues(db, id, 'people', [person]);
  }
});

describe('collectPeopleForRootPreview', () => {
  it('gathers everyone across the collection with root-relative image and thumbnail paths', () => {
    const people = collectPeopleForRootPreview(db);

    expect(people.map((person) => person.name)).toEqual(['Bob Jones', 'Jane Smith']);
    expect(people[1]).toEqual({
      name: 'Jane Smith',
      total: 1,
      images: [{
        path: '2025/03/a.jpg',
        thumbnailPath: '2025/03/thumbnails/a.jpg.thumb.jpg',
        name: 'a.jpg',
        subCollection: '2025/03',
      }],
    });
  });

  it('falls back to the full image for one whose processing failed, since its thumbnail may be what is missing', () => {
    const id = imageEntityId('2025/03', 'a.jpg');
    upsertEntity(db, { id, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: 'a.jpg', memberOf: subCrateId, processingError: 'Thumbnail generation failed' });

    const jane = collectPeopleForRootPreview(db).find((person) => person.name === 'Jane Smith');
    expect(jane.images[0].thumbnailPath).toEqual('2025/03/a.jpg');
  });

  it('lists every photo of a person, not a sample — the panel scrolls instead', () => {
    for (let i = 0; i < 30; i++) {
      const id = imageEntityId('2025/03', `extra-${i}.jpg`);
      upsertEntity(db, { id, roCrateId: subCrateId, entityType: ENTITY_TYPE_IMAGE, name: `extra-${i}.jpg`, memberOf: subCrateId });
      setEntityFacetValues(db, id, 'people', ['Jane Smith']);
    }

    const jane = collectPeopleForRootPreview(db).find((person) => person.name === 'Jane Smith');
    expect(jane.total).toEqual(31);
    expect(jane.images).toHaveLength(31);
  });
});

describe('regeneratePreviews', () => {
  it('rewrites every preview page, with a people browser on both levels', async () => {
    const result = await regeneratePreviews({ fsAdapter, db, rootName: 'Photo Collection' });

    expect(result.skipped).toEqual([]);
    expect(result.written.sort()).toEqual([PREVIEW_FILE_NAME, `2025/03/${PREVIEW_FILE_NAME}`].sort());

    const subHtml = new TextDecoder().decode(await fsAdapter.readFile(`2025/03/${PREVIEW_FILE_NAME}`));
    expect(subHtml).toContain('<h2>People</h2>');
    expect(subHtml).toContain('data-name="Jane Smith"');
    expect(subHtml).toContain('href="#viewer-0"');

    const rootHtml = new TextDecoder().decode(await fsAdapter.readFile(PREVIEW_FILE_NAME));
    expect(rootHtml).toContain('<h2>People</h2>');
    expect(rootHtml).toContain('data-name="Jane Smith"');
    expect(rootHtml).toContain('<img src="2025/03/thumbnails/a.jpg.thumb.jpg"');
  });

  it('reflects a rename already made in the crates, without re-reading any photo', async () => {
    // What a merge/rename leaves behind: the crate says the new name.
    const cratePath = `2025/03/${CRATE_FILE_NAME}`;
    const text = new TextDecoder().decode(await fsAdapter.readFile(cratePath));
    await fsAdapter.writeFile(cratePath, text.replaceAll('Jane Smith', 'Jane Q. Smith'));

    await regeneratePreviews({ fsAdapter, db, rootName: 'Photo Collection' });

    const subHtml = new TextDecoder().decode(await fsAdapter.readFile(`2025/03/${PREVIEW_FILE_NAME}`));
    expect(subHtml).toContain('data-name="Jane Q. Smith"');
    expect(subHtml).not.toContain('data-name="Jane Smith"');
  });

  it('skips, and reports, a sub-collection whose crate file has gone, rather than failing the whole run', async () => {
    await fsAdapter.deleteFile(`2025/03/${CRATE_FILE_NAME}`);

    const result = await regeneratePreviews({ fsAdapter, db, rootName: 'Photo Collection' });

    expect(result.skipped).toEqual([{ path: '2025/03', message: expect.stringContaining(CRATE_FILE_NAME) }]);
    expect(result.written).toEqual([PREVIEW_FILE_NAME]);
  });
});
