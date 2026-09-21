import { describe, it, expect, beforeEach } from 'vitest';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import {
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  setEntityFacetValues,
  listFacetValuesForEntity,
  getEntityRating,
  listRoCrates,
  listEntities,
  listFiles,
  crateEntityId,
  crateDirPathFromEntityId,
  imageEntityId,
  crateRelativeEntityId,
  personEntityId,
  petEntityId,
  facetValuesFromRecord,
  searchEntities,
  countSearchResults,
  facetCounts,
  getEntityById,
  getFileById,
  listFilesForEntity,
  deleteEntityById,
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

  it('leaves a person/pet id unchanged too, since it is not path-based and so is already crate-relative', () => {
    const roCrateId = crateEntityId('2025/03/10');
    const personId = personEntityId('Peter Malcolm Sefton');
    expect(crateRelativeEntityId(roCrateId, personId)).toEqual(personId);
  });
});

describe('personEntityId / petEntityId', () => {
  it('slugs a name into a stable id, the same regardless of which photo it came from', () => {
    expect(personEntityId('Peter Malcolm Sefton')).toEqual('arcp://name,rocphoto/person/PeterMalcolmSefton');
    expect(personEntityId('Peter Malcolm Sefton')).toEqual(personEntityId('Peter Malcolm Sefton'));
  });

  it('keeps a pet and a person of the same name in separate id spaces', () => {
    expect(personEntityId('Max')).not.toEqual(petEntityId('Max'));
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

  it('sets, replaces, and lists an entity\'s values for one facet', () => {
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, { id: 'photo.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg' });

    setEntityFacetValues(db, 'photo.jpg', 'keyword', ['Bird', 'Background']);
    expect(listFacetValuesForEntity(db, 'photo.jpg', 'keyword')).toEqual(['Background', 'Bird']);

    // A rescan reflects removed as well as added values, not just an
    // ever-growing accumulation.
    setEntityFacetValues(db, 'photo.jpg', 'keyword', ['Bird']);
    expect(listFacetValuesForEntity(db, 'photo.jpg', 'keyword')).toEqual(['Bird']);

    // A different facet on the same entity is unaffected.
    setEntityFacetValues(db, 'photo.jpg', 'camera', ['Google Pixel 6a']);
    expect(listFacetValuesForEntity(db, 'photo.jpg', 'camera')).toEqual(['Google Pixel 6a']);
    expect(listFacetValuesForEntity(db, 'photo.jpg', 'keyword')).toEqual(['Bird']);
  });

  it('gets an entity\'s own rating as a single number, or null if it has none', () => {
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, { id: 'photo.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg' });

    expect(getEntityRating(db, 'photo.jpg')).toBeNull();

    setEntityFacetValues(db, 'photo.jpg', 'rating', ['4']);
    expect(getEntityRating(db, 'photo.jpg')).toEqual(4);

    setEntityFacetValues(db, 'photo.jpg', 'rating', []);
    expect(getEntityRating(db, 'photo.jpg')).toBeNull();
  });
});

describe('facetValuesFromRecord', () => {
  it('combines Make and Model into a single camera facet value', () => {
    const record = { exifEntries: [{ name: 'Make', value: 'Google' }, { name: 'Model', value: 'Pixel 6a' }] };
    expect(facetValuesFromRecord(record).camera).toEqual('Google Pixel 6a');
  });

  it('prefers LensModel for the lens facet, falling back to LensMake alone', () => {
    const withModel = { exifEntries: [{ name: 'LensMake', value: 'Google' }, { name: 'LensModel', value: 'Pixel 6a back camera 4.38mm f/1.73' }] };
    expect(facetValuesFromRecord(withModel).lens).toEqual('Pixel 6a back camera 4.38mm f/1.73');

    const makeOnly = { exifEntries: [{ name: 'LensMake', value: 'Google' }] };
    expect(facetValuesFromRecord(makeOnly).lens).toEqual('Google');
  });

  it('leaves camera and lens null when no EXIF is available', () => {
    expect(facetValuesFromRecord({ exifEntries: [] })).toEqual({ camera: null, lens: null });
  });
});

describe('search and facetCounts', () => {
  let db;
  const rootId = crateEntityId('');

  // a.jpg and b.jpg share a camera; only a.jpg carries the keyword
  // 'Bird', shared with c.jpg (a different camera) — set up specifically
  // so tests can tell the four facet dimensions apart from one another.
  beforeEach(() => {
    db = openNodeSqlite(':memory:');
    ensureSchema(db);
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });

    const images = [
      { id: 'a.jpg', camera: 'Google Pixel 6a', lens: 'Pixel 6a back camera', dateCreated: '2025-03-10T00:00:00.000Z', keywords: ['Bird', 'Background'], rating: '5', people: ['Peter Malcolm Sefton'], pets: [] },
      { id: 'b.jpg', camera: 'Google Pixel 6a', lens: 'Pixel 6a front camera', dateCreated: '2025-06-01T00:00:00.000Z', keywords: [], rating: null, people: [], pets: ['Rex'] },
      { id: 'c.jpg', camera: 'Canon EOS R5', lens: 'RF 24-70mm', dateCreated: '2024-12-25T00:00:00.000Z', keywords: ['Bird'], rating: '5', people: ['Peter Malcolm Sefton'], pets: [] },
    ];
    for (const image of images) {
      upsertEntity(db, { id: image.id, roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: image.id, dateCreated: image.dateCreated });
      setEntityFacetValues(db, image.id, 'camera', [image.camera]);
      setEntityFacetValues(db, image.id, 'lens', [image.lens]);
      setEntityFacetValues(db, image.id, 'keyword', image.keywords);
      setEntityFacetValues(db, image.id, 'rating', image.rating ? [image.rating] : []);
      setEntityFacetValues(db, image.id, 'people', image.people);
      setEntityFacetValues(db, image.id, 'pets', image.pets);
    }
  });

  it('returns entities matching a single facet filter', () => {
    const results = searchEntities(db, { entityType: ENTITY_TYPE_IMAGE, camera: 'Google Pixel 6a' });
    expect(results.map((r) => r.id).sort()).toEqual(['a.jpg', 'b.jpg']);
    expect(countSearchResults(db, { entityType: ENTITY_TYPE_IMAGE, camera: 'Google Pixel 6a' })).toEqual(2);
  });

  it('combines multiple column-backed facet filters (AND)', () => {
    const results = searchEntities(db, { camera: 'Google Pixel 6a', year: '2025' });
    expect(results).toHaveLength(2);
    const results2024 = searchEntities(db, { camera: 'Google Pixel 6a', year: '2024' });
    expect(results2024).toHaveLength(0);
  });

  it('filters by a keyword, and combines it with a column-backed facet (AND)', () => {
    const byKeyword = searchEntities(db, { keyword: 'Bird' });
    expect(byKeyword.map((r) => r.id).sort()).toEqual(['a.jpg', 'c.jpg']);

    const combined = searchEntities(db, { keyword: 'Bird', camera: 'Google Pixel 6a' });
    expect(combined.map((r) => r.id)).toEqual(['a.jpg']);
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

  it('computes keyword facet counts', () => {
    const counts = facetCounts(db, 'keyword', {});
    expect(counts).toEqual(expect.arrayContaining([
      { value: 'Bird', count: 2 },
      { value: 'Background', count: 1 },
    ]));
  });

  it('filters by rating, leaving out entities with no (or a zero) rating', () => {
    const results = searchEntities(db, { rating: '5' });
    expect(results.map((r) => r.id).sort()).toEqual(['a.jpg', 'c.jpg']);

    const counts = facetCounts(db, 'rating', {});
    expect(counts).toEqual([{ value: '5', count: 2 }]);
  });

  it('filters by people and by pets as separate facets, since a photo can have both, one, or neither', () => {
    const byPerson = searchEntities(db, { people: 'Peter Malcolm Sefton' });
    expect(byPerson.map((r) => r.id).sort()).toEqual(['a.jpg', 'c.jpg']);

    const byPet = searchEntities(db, { pets: 'Rex' });
    expect(byPet.map((r) => r.id)).toEqual(['b.jpg']);

    expect(facetCounts(db, 'people', {})).toEqual([{ value: 'Peter Malcolm Sefton', count: 2 }]);
    expect(facetCounts(db, 'pets', {})).toEqual([{ value: 'Rex', count: 1 }]);
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

  it('narrows a column-backed facet\'s counts by an active keyword filter, and vice versa', () => {
    const cameraCountsUnderBird = facetCounts(db, 'camera', { keyword: 'Bird' });
    expect(cameraCountsUnderBird.sort((a, b) => a.value.localeCompare(b.value))).toEqual([
      { value: 'Canon EOS R5', count: 1 },
      { value: 'Google Pixel 6a', count: 1 },
    ]);

    const keywordCountsUnderCamera = facetCounts(db, 'keyword', { camera: 'Google Pixel 6a' });
    expect(keywordCountsUnderCamera.sort((a, b) => a.value.localeCompare(b.value))).toEqual([
      { value: 'Background', count: 1 },
      { value: 'Bird', count: 1 },
    ]);
  });

  it('rejects an unknown facet name rather than building unsafe SQL from it', () => {
    expect(() => facetCounts(db, 'not-a-real-facet', {})).toThrow();
  });
});

describe('deleteEntityById', () => {
  it('removes an entity, its facet rows, and its file row, so it stops showing up in search and facet counts', () => {
    const db = openNodeSqlite(':memory:');
    ensureSchema(db);
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, { id: 'a.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'a.jpg' });
    setEntityFacetValues(db, 'a.jpg', 'keyword', ['Bird']);
    upsertFile(db, { id: 'a.jpg', entityId: 'a.jpg', filename: 'a.jpg', mediaType: 'image/jpeg', size: 10, relativePath: 'a.jpg' });

    deleteEntityById(db, 'a.jpg');

    expect(getEntityById(db, 'a.jpg')).toBeUndefined();
    expect(getFileById(db, 'a.jpg')).toBeUndefined();
    expect(listFacetValuesForEntity(db, 'a.jpg', 'keyword')).toEqual([]);
    expect(facetCounts(db, 'keyword', {})).toEqual([]);
  });

  it('leaves other entities and their facets untouched', () => {
    const db = openNodeSqlite(':memory:');
    ensureSchema(db);
    const rootId = crateEntityId('');
    upsertRoCrate(db, { id: rootId, path: '.', name: 'root' });
    upsertEntity(db, { id: 'a.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'a.jpg' });
    upsertEntity(db, { id: 'b.jpg', roCrateId: rootId, entityType: ENTITY_TYPE_IMAGE, name: 'b.jpg' });
    setEntityFacetValues(db, 'b.jpg', 'keyword', ['Bird']);

    deleteEntityById(db, 'a.jpg');

    expect(getEntityById(db, 'b.jpg')).toBeTruthy();
    expect(listFacetValuesForEntity(db, 'b.jpg', 'keyword')).toEqual(['Bird']);
  });
});
