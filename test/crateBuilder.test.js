import { describe, it, expect } from 'vitest';
import {
  loadOrCreateCrate,
  serializeCrate,
  setDatasetName,
  addSubCrateReference,
  addImageEntity,
  recordedModifiedTime,
  readImageRecord,
} from '../src/core/crateBuilder.js';

describe('setDatasetName', () => {
  it('sets the root dataset name only when not already set', () => {
    const crate = loadOrCreateCrate(null);
    setDatasetName(crate, 'First');
    setDatasetName(crate, 'Second');
    expect(crate.rootDataset.name).toEqual(['First']);
  });
});

describe('addSubCrateReference', () => {
  it('adds a hasPart reference to the sub-crate directory, without duplicating it on repeat calls', () => {
    const crate = loadOrCreateCrate(null);
    addSubCrateReference(crate, '2024');
    addSubCrateReference(crate, '2024');

    const hasPart = crate.rootDataset.hasPart;
    const matches = hasPart.filter((ref) => ref['@id'] === '2024/');
    expect(matches).toHaveLength(1);
  });
});

describe('addImageEntity', () => {
  it('records an EXIF extraction error in the description property', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exifError: 'EXIF extraction failed: bad segment' });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.description).toEqual(['EXIF extraction failed: bad segment']);
    expect(crate.rootDataset.hasPart.map((r) => r['@id'])).toContain('photo.jpg');
  });

  it('maps EXIF fields, including lens make and model, onto dateCreated and exifData', () => {
    const crate = loadOrCreateCrate(null);
    const exif = {
      DateTimeOriginal: new Date('2024-01-02T03:04:05Z'),
      Make: 'Acme',
      Model: 'X100',
      LensMake: 'Acme Optics',
      LensModel: 'X100 back camera 4.38mm f/1.73',
    };
    addImageEntity(crate, { path: 'photo.jpg', exif });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.dateCreated).toEqual(['2024-01-02T03:04:05.000Z']);
    const exifData = entity.exifData.map((ref) => {
      const pv = crate.getEntity(ref['@id']);
      return [pv.name[0], pv.value[0]];
    });
    expect(exifData).toEqual(expect.arrayContaining([
      ['Make', 'Acme'],
      ['Model', 'X100'],
      ['LensMake', 'Acme Optics'],
      ['LensModel', 'X100 back camera 4.38mm f/1.73'],
    ]));
  });

  it('links a thumbnail entity via the schema.org thumbnail property', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', thumbnailPath: 'thumbnails/photo.jpg.thumb.jpg' });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.thumbnail[0]['@id']).toEqual('thumbnails/photo.jpg.thumb.jpg');
    const thumbEntity = crate.getEntity('thumbnails/photo.jpg.thumb.jpg');
    expect(thumbEntity).toBeTruthy();
  });

  it('does not duplicate the hasPart entry when the same image is processed again on rescan', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });
    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });

    const matches = crate.rootDataset.hasPart.filter((ref) => ref['@id'] === 'photo.jpg');
    expect(matches).toHaveLength(1);
  });

  it('reuses the same exifData PropertyValue node on rescan instead of accumulating orphans', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });
    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Replacement' } });

    const graph = crate.toJSON()['@graph'];
    const makeNodes = graph.filter((e) => e['@id'] === 'photo.jpg#exif-Make');
    expect(makeNodes).toHaveLength(1);
    expect(makeNodes[0].value).toEqual('Replacement');
  });

  it('round-trips through serialization and reloading', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });

    const reloaded = loadOrCreateCrate(serializeCrate(crate));
    expect(reloaded.getEntity('photo.jpg').name).toEqual(['photo.jpg']);
  });

  it('combines an EXIF error and a thumbnail generation error into one description, so a file\'s full error state lives in one place', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'photo.jpg',
      exifError: 'EXIF extraction failed: bad segment',
      thumbnailError: 'Thumbnail generation failed: unsupported format',
    });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.description[0]).toContain('EXIF extraction failed: bad segment');
    expect(entity.description[0]).toContain('Thumbnail generation failed: unsupported format');
  });

  it('records a thumbnail error even when EXIF succeeded', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Make: 'Acme' },
      thumbnailError: 'Thumbnail generation failed: unsupported format',
    });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.description).toEqual(['Thumbnail generation failed: unsupported format']);
    // EXIF processing still happened normally alongside the thumbnail failure.
    expect(entity.exifData).toBeTruthy();
  });

  it('records the source file modification time as dateModified', () => {
    const crate = loadOrCreateCrate(null);
    const modifiedAt = new Date('2024-06-01T12:00:00.000Z').getTime();
    addImageEntity(crate, { path: 'photo.jpg', sourceModifiedAt: modifiedAt });

    expect(recordedModifiedTime(crate, 'photo.jpg')).toEqual(modifiedAt);
  });
});

describe('recordedModifiedTime', () => {
  it('returns null when the image has no entity yet', () => {
    const crate = loadOrCreateCrate(null);
    expect(recordedModifiedTime(crate, 'nonexistent.jpg')).toBeNull();
  });

  it('returns null when the entity exists but was never given a sourceModifiedAt', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });
    expect(recordedModifiedTime(crate, 'photo.jpg')).toBeNull();
  });
});

describe('readImageRecord', () => {
  it('returns null when the image has no entity yet', () => {
    const crate = loadOrCreateCrate(null);
    expect(readImageRecord(crate, 'nonexistent.jpg')).toBeNull();
  });

  it('reconstructs the same record shape addImageEntity returns, from an existing entity', () => {
    const crate = loadOrCreateCrate(null);
    const exif = { DateTimeOriginal: new Date('2024-01-02T03:04:05Z'), Make: 'Acme', Model: 'X100' };
    const original = addImageEntity(crate, { path: 'photo.jpg', exif, thumbnailPath: 'thumbnails/photo.jpg.thumb.jpg' });

    const reloadedCrate = loadOrCreateCrate(serializeCrate(crate));
    const record = readImageRecord(reloadedCrate, 'photo.jpg');

    expect(record.name).toEqual(original.name);
    expect(record.dateCreated).toEqual(original.dateCreated);
    expect(record.thumbnailPath).toEqual(original.thumbnailPath);
    expect(record.exifEntries.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      original.exifEntries.sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it('reconstructs a recorded description (EXIF and/or thumbnail error)', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exifError: 'bad file' });

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.description).toEqual('bad file');
  });

  it('reconstructs keywords, and defaults to an empty array when none were recorded', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { hierarchicalSubject: ['Bird|Nankeen Kestrel'] } });
    addImageEntity(crate, { path: 'b.jpg' });

    const reloaded = loadOrCreateCrate(serializeCrate(crate));
    expect(readImageRecord(reloaded, 'a.jpg').keywords.sort()).toEqual(['Bird', 'Nankeen Kestrel']);
    expect(readImageRecord(reloaded, 'b.jpg').keywords).toEqual([]);
  });
});

describe('addImageEntity keywords', () => {
  it('records flattened keywords on the entity and in the returned record', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, { path: 'photo.jpg', exif: { hierarchicalSubject: ['Bird|Nankeen Kestrel', 'Background'] } });

    expect(record.keywords.sort()).toEqual(['Background', 'Bird', 'Nankeen Kestrel']);
    expect(crate.getEntity('photo.jpg').keywords.sort()).toEqual(['Background', 'Bird', 'Nankeen Kestrel']);
  });

  it('does not set keywords when there are none, or when EXIF failed', () => {
    const crate = loadOrCreateCrate(null);
    const clean = addImageEntity(crate, { path: 'a.jpg', exif: { Make: 'Acme' } });
    const failed = addImageEntity(crate, { path: 'b.jpg', exif: { hierarchicalSubject: ['Bird'] }, exifError: 'bad file' });

    expect(clean.keywords).toEqual([]);
    expect(failed.keywords).toEqual([]);
    expect(crate.getEntity('a.jpg').keywords).toBeUndefined();
    expect(crate.getEntity('b.jpg').keywords).toBeUndefined();
  });
});
