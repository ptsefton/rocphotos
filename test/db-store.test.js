import { describe, it, expect, beforeEach } from 'vitest';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import {
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  listRoCrates,
  listEntities,
  listFiles,
  crateEntityId,
  crateDirPathFromEntityId,
  imageEntityId,
  crateRelativeEntityId,
  facetValuesFromRecord,
  searchEntities,
  countSearchResults,
  facetCounts,
  getEntityById,
  getFileById,
  listFilesForEntity,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
  DEFAULT_LICENSE_ID,
} from '../src/core/db/store.js';

describe('crateEntityId / crateDirPathFromEntityId / imageEntityId', () => {
  it('gives the root crate the RO-Crate root id, and a trailing-slash id for sub-crates', () => {
    expect(crateEntityId('')).toEqual('./');
    expect(crateEntityId('2025/03/10')).toEqual('2025/03/10/');
  });

  it('crateDirPathFromEntityId is the exact inverse of crateEntityId', () => {
    expect(crateDirPathFromEntityId(crateEntityId(''))).toEqual('');
    expect(crateDirPathFromEntityId(crateEntityId('2025/03/10'))).toEqual('2025/03/10');
  });

  it('gives an image a collection-relative id, unique across every crate', () => {
    expect(imageEntityId('', 'photo.jpg')).toEqual('photo.jpg');
    expect(imageEntityId('2025/03/10', 'photo.jpg')).toEqual('2025/03/10/photo.jpg');
  });
});

describe('crateRelativeEntityId', () => {
  it('is the inverse of imageEntityId: strips the crate directory prefix back off', () => {
    const roCrateId = crateEntityId('2025/03/10');
    expect(crateRelativeEntityId(roCrateId, imageEntityId('2025/03/10', 'photo.jpg'))).toEqual('photo.jpg');
  });

  it('handles an image nested in a subdirectory absorbed into the crate', () => {
    const roCrateId = crateEntityId('2006/01/03');
    const collectionId = imageEntityId('2006/01/03', 'Originals/CIMG2390.JPG');
    expect(crateRelativeEntityId(roCrateId, collectionId)).toEqual('Originals/CIMG2390.JPG');
  });

  it('maps a sub-crate\'s own Collection entity id back to the RO-Crate root convention', () => {
    const roCrateId = crateEntityId('2025/03/10');
    expect(crateRelativeEntityId(roCrateId, roCrateId)).toEqual('./');
  });

  it('leaves root-crate ids unchanged, since they are already crate-relative', () => {
    const roCrateId = crateEntityId('');
    expect(crateRelativeEntityId(roCrateId, imageEntityId('', 'photo.jpg'))).toEqual('photo.jpg');
    expect(crateRelativeEntityId(roCrateId, roCrateId)).toEqual('./');
  });
});

describe('db store', () => {
  let db;

  beforeEach(() => {
    db = openNodeSqlite(':memory:');
    ensureSchema(db);
  });

  it('upserts a ro_crate row and lists it back', () => {
    upsertRoCrate(db, { id: crateEntityId('2025/03/10'), path: '2025/03/10', name: '2025/03/10' });

    const rows = listRoCrates(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toEqual('2025/03/10/');
    expect(rows[0].name).toEqual('2025/03/10');
  });

  it('gives the root crate a non-blank id and path', () => {
    upsertRoCrate(db, { id: crateEntityId(''), path: '.', name: 'Photo Collection' });

    const rows = listRoCrates(db);
    expect(rows[0].id).toEqual('./');
    expect(rows[0].path).toEqual('.');
  });

  it('updates rather than duplicates a ro_crate row on a repeat scan', () => {
    const id = crateEntityId('2025/03/10');
    upsertRoCrate(db, { id, path: '2025/03/10', name: 'Old Name' });
    upsertRoCrate(db, { id, path: '2025/03/10', name: 'New Name' });

    const rows = listRoCrates(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toEqual('New Name');
  });

  it('upserts an entity with AROCAPI-shaped defaults applied', () => {
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, {
      id: 'photo.jpg',
      roCrateId: rootId,
      entityType: ENTITY_TYPE_IMAGE,
      name: 'photo.jpg',
      memberOf: rootId,
    });

    const entity = listEntities(db)[0];
    expect(entity.ro_crate_id).toEqual(rootId);
    expect(entity.entity_type).toEqual(ENTITY_TYPE_IMAGE);
    expect(entity.member_of).toEqual('./');
    expect(entity.metadata_license_id).toEqual(DEFAULT_LICENSE_ID);
    expect(entity.content_license_id).toEqual(DEFAULT_LICENSE_ID);
    expect(entity.access_metadata).toEqual(1);
    expect(entity.access_content).toEqual(1);
  });

  it('does not duplicate an entity on repeat upsert, and description reflects an EXIF error', () => {
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, { id: 'photo.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg' });
    upsertEntity(db, {
      id: 'photo.jpg',
      roCrateId: rootId,
      entityType: ENTITY_TYPE_IMAGE,
      name: 'photo.jpg',
      description: 'EXIF extraction failed: bad segment',
    });

    const rows = listEntities(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toEqual('EXIF extraction failed: bad segment');
  });

  it('upserts a file row linked to its entity', () => {
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, { id: 'photo.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg' });
    upsertFile(db, {
      id: 'photo.jpg',
      entityId: 'photo.jpg',
      filename: 'photo.jpg',
      mediaType: 'image/jpeg',
      size: 12345,
      relativePath: 'photo.jpg',
    });

    const file = listFiles(db)[0];
    expect(file.entity_id).toEqual('photo.jpg');
    expect(file.media_type).toEqual('image/jpeg');
    expect(file.size).toEqual(12345);
  });

  it('models a root crate with one sub-crate and one image, joined via member_of and ro_crate_id', () => {
    const rootId = crateEntityId('');
    const subCrateId = crateEntityId('2025/03/10');

    upsertRoCrate(db, { id: rootId, path: '.', name: 'Photo Collection' });
    upsertEntity(db, { id: rootId, roCrateId: rootId, entityType: ENTITY_TYPE_COLLECTION, name: 'Photo Collection' });

    upsertRoCrate(db, { id: subCrateId, path: '2025/03/10', name: '2025/03/10' });
    upsertEntity(db, {
      id: subCrateId,
      roCrateId: subCrateId,
      entityType: ENTITY_TYPE_COLLECTION,
      name: '2025/03/10',
      memberOf: rootId,
    });

    const entityId = imageEntityId('2025/03/10', 'photo.jpg');
    upsertEntity(db, {
      id: entityId,
      roCrateId: subCrateId,
      entityType: ENTITY_TYPE_IMAGE,
      name: 'photo.jpg',
      memberOf: subCrateId,
    });

    const roCrates = listRoCrates(db);
    const entities = listEntities(db);
    expect(entities).toHaveLength(3);

    const image = entities.find((e) => e.id === '2025/03/10/photo.jpg');
    const subCrate = entities.find((e) => e.id === image.member_of);
    const root = entities.find((e) => e.id === subCrate.member_of);
    expect(root.id).toEqual('./');
    expect(root.member_of).toBeNull();

    // Every crate-identifying column agrees: an entity's ro_crate_id
    // matches both a real ro_crates.id row and that crate's own
    // Collection entity's id — traceable across sheets/tables by id.
    expect(image.ro_crate_id).toEqual(subCrate.id);
    expect(roCrates.map((r) => r.id)).toEqual(expect.arrayContaining([subCrate.ro_crate_id, root.ro_crate_id]));
  });

  it('gets a single entity, its files, and a single file by id', () => {
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, { id: 'photo.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg' });
    upsertFile(db, { id: 'photo.jpg', entityId: 'photo.jpg', filename: 'photo.jpg', mediaType: 'image/jpeg', size: 100, relativePath: 'photo.jpg' });

    expect(getEntityById(db, 'photo.jpg').name).toEqual('photo.jpg');
    expect(getEntityById(db, 'missing.jpg')).toBeUndefined();
    expect(getFileById(db, 'photo.jpg').media_type).toEqual('image/jpeg');
    expect(listFilesForEntity(db, 'photo.jpg')).toHaveLength(1);
  });
});

describe('facetValuesFromRecord', () => {
  it('combines Make and Model into a single camera facet value', () => {
    const record = { dateCreated: null, exifEntries: [{ name: 'Make', value: 'Google' }, { name: 'Model', value: 'Pixel 6a' }] };
    expect(facetValuesFromRecord(record).camera).toEqual('Google Pixel 6a');
  });

  it('prefers LensModel for the lens facet, falling back to LensMake alone', () => {
    const withModel = { dateCreated: null, exifEntries: [{ name: 'LensMake', value: 'Google' }, { name: 'LensModel', value: 'Pixel 6a back camera 4.38mm f/1.73' }] };
    expect(facetValuesFromRecord(withModel).lens).toEqual('Pixel 6a back camera 4.38mm f/1.73');

    const makeOnly = { dateCreated: null, exifEntries: [{ name: 'LensMake', value: 'Google' }] };
    expect(facetValuesFromRecord(makeOnly).lens).toEqual('Google');
  });

  it('leaves camera and lens null, and passes dateCreated through, when no EXIF is available', () => {
    const record = { dateCreated: '2025-03-10T00:00:00.000Z', exifEntries: [] };
    expect(facetValuesFromRecord(record)).toEqual({ dateCreated: '2025-03-10T00:00:00.000Z', camera: null, lens: null });
  });
});

describe('search and facetCounts', () => {
  let db;
  const rootId = crateEntityId('');

  beforeEach(() => {
    db = openNodeSqlite(':memory:');
    ensureSchema(db);
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });

    const images = [
      { id: 'a.jpg', camera: 'Google Pixel 6a', lens: 'Pixel 6a back camera', dateCreated: '2025-03-10T00:00:00.000Z' },
      { id: 'b.jpg', camera: 'Google Pixel 6a', lens: 'Pixel 6a front camera', dateCreated: '2025-06-01T00:00:00.000Z' },
      { id: 'c.jpg', camera: 'Canon EOS R5', lens: 'RF 24-70mm', dateCreated: '2024-12-25T00:00:00.000Z' },
    ];
    for (const image of images) {
      upsertEntity(db, {
        id: image.id,
        roCrateId: rootId,
        entityType: ENTITY_TYPE_IMAGE,
        name: image.id,
        dateCreated: image.dateCreated,
        camera: image.camera,
        lens: image.lens,
      });
    }
  });

  it('returns entities matching a single facet filter', () => {
    const results = searchEntities(db, { entityType: ENTITY_TYPE_IMAGE, camera: 'Google Pixel 6a' });
    expect(results.map((r) => r.id).sort()).toEqual(['a.jpg', 'b.jpg']);
    expect(countSearchResults(db, { entityType: ENTITY_TYPE_IMAGE, camera: 'Google Pixel 6a' })).toEqual(2);
  });

  it('combines multiple facet filters (AND)', () => {
    const results = searchEntities(db, { camera: 'Google Pixel 6a', year: '2025' });
    expect(results).toHaveLength(2);
    const results2024 = searchEntities(db, { camera: 'Google Pixel 6a', year: '2024' });
    expect(results2024).toHaveLength(0);
  });

  it('computes camera facet counts', () => {
    const counts = facetCounts(db, 'camera', {});
    expect(counts).toEqual(expect.arrayContaining([
      { value: 'Google Pixel 6a', count: 2 },
      { value: 'Canon EOS R5', count: 1 },
    ]));
  });

  it('computes year facet counts, derived from date_created', () => {
    const counts = facetCounts(db, 'year', {});
    expect(counts).toEqual(expect.arrayContaining([
      { value: '2025', count: 2 },
      { value: '2024', count: 1 },
    ]));
  });

  it('does not let a facet\'s own selected value collapse its own counts to just that value', () => {
    // With camera already filtered to Google Pixel 6a, the camera facet
    // itself should still show every camera (so the user can switch),
    // while a *different* facet (year) should be narrowed by it.
    const cameraCounts = facetCounts(db, 'camera', { camera: 'Google Pixel 6a' });
    expect(cameraCounts).toEqual(expect.arrayContaining([
      { value: 'Google Pixel 6a', count: 2 },
      { value: 'Canon EOS R5', count: 1 },
    ]));

    const yearCounts = facetCounts(db, 'year', { camera: 'Google Pixel 6a' });
    expect(yearCounts).toEqual([{ value: '2025', count: 2 }]);
  });

  it('rejects an unknown facet name rather than building unsafe SQL from it', () => {
    expect(() => facetCounts(db, 'not-a-real-facet', {})).toThrow();
  });
});
