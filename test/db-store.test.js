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
  imageEntityId,
  crateRelativeEntityId,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
  DEFAULT_LICENSE_ID,
} from '../src/core/db/store.js';

describe('crateEntityId / imageEntityId', () => {
  it('gives the root crate the RO-Crate root id, and a trailing-slash id for sub-crates', () => {
    expect(crateEntityId('')).toEqual('./');
    expect(crateEntityId('2025/03/10')).toEqual('2025/03/10/');
  });

  it('gives an image a collection-relative id, unique across every crate', () => {
    expect(imageEntityId('', 'photo.jpg')).toEqual('photo.jpg');
    expect(imageEntityId('2025/03/10', 'photo.jpg')).toEqual('2025/03/10/photo.jpg');
  });
});

describe('crateRelativeEntityId', () => {
  it('is the inverse of imageEntityId: strips the crate directory prefix back off', () => {
    expect(crateRelativeEntityId('2025/03/10', imageEntityId('2025/03/10', 'photo.jpg'))).toEqual('photo.jpg');
  });

  it('handles an image nested in a subdirectory absorbed into the crate', () => {
    const collectionId = imageEntityId('2006/01/03', 'Originals/CIMG2390.JPG');
    expect(crateRelativeEntityId('2006/01/03', collectionId)).toEqual('Originals/CIMG2390.JPG');
  });

  it('maps a sub-crate\'s own Collection entity id back to the RO-Crate root convention', () => {
    expect(crateRelativeEntityId('2025/03/10', crateEntityId('2025/03/10'))).toEqual('./');
  });

  it('leaves root-crate ids unchanged, since they are already crate-relative', () => {
    expect(crateRelativeEntityId('', imageEntityId('', 'photo.jpg'))).toEqual('photo.jpg');
    expect(crateRelativeEntityId('', crateEntityId(''))).toEqual('./');
  });
});

describe('db store', () => {
  let db;

  beforeEach(() => {
    db = openNodeSqlite(':memory:');
    ensureSchema(db);
  });

  it('upserts a ro_crate row and lists it back', () => {
    upsertRoCrate(db, { id: '2025/03/10', path: '2025/03/10', name: '2025/03/10' });

    const rows = listRoCrates(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toEqual('2025/03/10');
    expect(rows[0].name).toEqual('2025/03/10');
  });

  it('updates rather than duplicates a ro_crate row on a repeat scan', () => {
    upsertRoCrate(db, { id: '2025/03/10', path: '2025/03/10', name: 'Old Name' });
    upsertRoCrate(db, { id: '2025/03/10', path: '2025/03/10', name: 'New Name' });

    const rows = listRoCrates(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toEqual('New Name');
  });

  it('upserts an entity with AROCAPI-shaped defaults applied', () => {
    upsertRoCrate(db, { id: '', path: '', name: 'root' });
    upsertEntity(db, {
      id: 'photo.jpg',
      roCrateId: '',
      entityType: ENTITY_TYPE_IMAGE,
      name: 'photo.jpg',
      memberOf: './',
    });

    const entity = listEntities(db)[0];
    expect(entity.entity_type).toEqual(ENTITY_TYPE_IMAGE);
    expect(entity.member_of).toEqual('./');
    expect(entity.metadata_license_id).toEqual(DEFAULT_LICENSE_ID);
    expect(entity.content_license_id).toEqual(DEFAULT_LICENSE_ID);
    expect(entity.access_metadata).toEqual(1);
    expect(entity.access_content).toEqual(1);
  });

  it('does not duplicate an entity on repeat upsert, and description reflects an EXIF error', () => {
    upsertRoCrate(db, { id: '', path: '', name: 'root' });
    upsertEntity(db, { id: 'photo.jpg', roCrateId: '', entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg' });
    upsertEntity(db, {
      id: 'photo.jpg',
      roCrateId: '',
      entityType: ENTITY_TYPE_IMAGE,
      name: 'photo.jpg',
      description: 'EXIF extraction failed: bad segment',
    });

    const rows = listEntities(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toEqual('EXIF extraction failed: bad segment');
  });

  it('upserts a file row linked to its entity', () => {
    upsertRoCrate(db, { id: '', path: '', name: 'root' });
    upsertEntity(db, { id: 'photo.jpg', roCrateId: '', entityType: ENTITY_TYPE_IMAGE, name: 'photo.jpg' });
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

  it('models a root crate with one sub-crate and one image, joined via member_of', () => {
    upsertRoCrate(db, { id: '', path: '', name: 'Photo Collection' });
    upsertEntity(db, { id: crateEntityId(''), roCrateId: '', entityType: ENTITY_TYPE_COLLECTION, name: 'Photo Collection' });

    upsertRoCrate(db, { id: '2025/03/10', path: '2025/03/10', name: '2025/03/10' });
    upsertEntity(db, {
      id: crateEntityId('2025/03/10'),
      roCrateId: '2025/03/10',
      entityType: ENTITY_TYPE_COLLECTION,
      name: '2025/03/10',
      memberOf: crateEntityId(''),
    });

    const entityId = imageEntityId('2025/03/10', 'photo.jpg');
    upsertEntity(db, {
      id: entityId,
      roCrateId: '2025/03/10',
      entityType: ENTITY_TYPE_IMAGE,
      name: 'photo.jpg',
      memberOf: crateEntityId('2025/03/10'),
    });

    const entities = listEntities(db);
    expect(entities).toHaveLength(3);

    const image = entities.find((e) => e.id === '2025/03/10/photo.jpg');
    const subCrate = entities.find((e) => e.id === image.member_of);
    const root = entities.find((e) => e.id === subCrate.member_of);
    expect(root.id).toEqual('./');
    expect(root.member_of).toBeNull();
  });
});
