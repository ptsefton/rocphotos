import { describe, it, expect } from 'vitest';
import {
  loadOrCreateCrate,
  serializeCrate,
  setDatasetName,
  addSubCrateReference,
  addImageEntity,
  recordedModifiedTime,
  readImageRecord,
  setImageKeywords,
  setImageRating,
  setImageTitle,
  setImageDescription,
  removeImageEntity,
  setAlbumEntity,
  albumMemberIds,
  addStandoffFaceRegion,
  renamePersonInCrate,
  subjectInstanceId,
  syncRootCrateSubjects,
  foldSubjectInto,
} from '../src/core/crateBuilder.js';
import { personEntityId, petEntityId } from '../src/core/db/store.js';

describe('loadOrCreateCrate @context', () => {
  const contextObject = (crate) => JSON.parse(serializeCrate(crate))['@context'].find((entry) => typeof entry === 'object');

  it('binds the oa prefix, so the standoff region terms are real Web Annotation IRIs rather than literal "oa:..."', () => {
    const crate = loadOrCreateCrate(null);

    expect(contextObject(crate).oa).toEqual('http://www.w3.org/ns/oa#');
    for (const term of ['oa:Annotation', 'oa:hasBody', 'oa:hasTarget', 'oa:motivatedBy', 'oa:identifying']) {
      expect(crate.resolveTerm(term)).toEqual(`http://www.w3.org/ns/oa#${term.slice(3)}`);
    }
    // prov comes from RO-Crate's own context; this must not have disturbed it.
    expect(crate.resolveTerm('prov:specializationOf')).toEqual('http://www.w3.org/ns/prov#specializationOf');
  });

  it('adds it to a crate written before the binding existed', () => {
    const legacy = JSON.stringify({
      '@context': ['https://w3id.org/ro/crate/1.2/context', { '@vocab': 'http://schema.org/' }],
      '@graph': [
        { '@id': './', '@type': 'Dataset', name: 'old' },
        { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
      ],
    });

    expect(contextObject(loadOrCreateCrate(legacy)).oa).toEqual('http://www.w3.org/ns/oa#');
  });

  it('binds the terms this app coins, so they resolve instead of falling through @vocab', () => {
    const crate = loadOrCreateCrate(null);
    const context = contextObject(crate);

    for (const term of ['Pet', 'ImageRegion', 'FaceEmbedding', 'regionType', 'writtenToFile', 'rating', 'embedding', 'xPosition', 'processingError']) {
      expect(context[term]).toEqual(`https://w3id.org/ldac/rocphotos/terms#${term}`);
      expect(crate.resolveTerm(term)).toEqual(`https://w3id.org/ldac/rocphotos/terms#${term}`);
    }
  });

  it('leaves terms that schema.org already defines alone, rather than redefining them', () => {
    const crate = loadOrCreateCrate(null);

    for (const term of ['width', 'height', 'name', 'title', 'about', 'keywords', 'thumbnail']) {
      expect(contextObject(crate)[term]).toBeUndefined();
      expect(crate.resolveTerm(term)).toEqual(`http://schema.org/${term}`);
    }
    expect(crate.resolveTerm('Person')).toEqual('http://schema.org/Person');
  });

  it('gains it exactly once however many times a crate is read and written back', () => {
    let text = serializeCrate(loadOrCreateCrate(null));
    for (let i = 0; i < 5; i++) text = serializeCrate(loadOrCreateCrate(text));

    const context = JSON.parse(text)['@context'];
    expect(context).toHaveLength(2);
    expect(JSON.stringify(context).split('ns/oa#')).toHaveLength(2);
    // Each coined term defined once, not once per round trip.
    const coined = Object.entries(context[1]).filter(([, iri]) => String(iri).startsWith('https://w3id.org/ldac/rocphotos/terms#'));
    expect(coined).toHaveLength(new Set(coined.map(([term]) => term)).size);
  });
});

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

describe('setAlbumEntity / albumMemberIds', () => {
  it('records each member as a prov:specializationOf proxy, not a direct reference to the real image', () => {
    const crate = loadOrCreateCrate(null);
    setAlbumEntity(crate, { id: 'album1', name: 'Road Trip', description: null, memberIds: ['a.jpg', 'b.jpg'] });

    const album = crate.getEntity('album1');
    expect(album.hasPart.map((ref) => ref['@id'])).toEqual(['album1#item-0', 'album1#item-1']);

    const proxy0 = crate.getEntity('album1#item-0');
    expect(proxy0['@type']).toEqual(['ImageObject']);
    expect(albumMemberIds(crate, 'album1')).toEqual(['a.jpg', 'b.jpg']);
  });

  it('returns [] for an album with no entity yet, rather than throwing', () => {
    const crate = loadOrCreateCrate(null);
    expect(albumMemberIds(crate, 'nope')).toEqual([]);
  });

  it('never replaces an already-existing proxy, so a name/description set on it later would survive further calls', () => {
    const crate = loadOrCreateCrate(null);
    setAlbumEntity(crate, { id: 'album1', name: 'Road Trip', description: null, memberIds: ['a.jpg'] });

    // Simulates a future per-item caption feature setting something on
    // the proxy directly — setAlbumEntity itself never writes to name/
    // description on a proxy, only prov:specializationOf.
    crate.getEntity('album1#item-0').name = 'The best photo of the trip';

    // Editing the album's own description and adding a second member —
    // both real reasons setAlbumEntity gets called again — must not
    // touch the first proxy's own caption.
    setAlbumEntity(crate, { id: 'album1', name: 'Road Trip', description: 'Updated', memberIds: ['a.jpg', 'b.jpg'] });

    expect(crate.getEntity('album1#item-0').name).toEqual(['The best photo of the trip']);
    expect(albumMemberIds(crate, 'album1')).toEqual(['a.jpg', 'b.jpg']);
  });
});

describe('addImageEntity', () => {
  it('records an EXIF extraction error in the processingError property', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exifError: 'EXIF extraction failed: bad segment' });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.processingError).toEqual(['EXIF extraction failed: bad segment']);
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

  it('combines an EXIF error and a thumbnail generation error into one processingError, so a file\'s full error state lives in one place', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'photo.jpg',
      exifError: 'EXIF extraction failed: bad segment',
      thumbnailError: 'Thumbnail generation failed: unsupported format',
    });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.processingError[0]).toContain('EXIF extraction failed: bad segment');
    expect(entity.processingError[0]).toContain('Thumbnail generation failed: unsupported format');
  });

  it('records a thumbnail error even when EXIF succeeded', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Make: 'Acme' },
      thumbnailError: 'Thumbnail generation failed: unsupported format',
    });

    const entity = crate.getEntity('photo.jpg');
    expect(entity.processingError).toEqual(['Thumbnail generation failed: unsupported format']);
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

  it('reconstructs a recorded processingError (EXIF and/or thumbnail error)', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exifError: 'bad file' });

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.processingError).toEqual('bad file');
  });

  it('reconstructs keywords, and defaults to an empty array when none were recorded', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { hierarchicalSubject: ['Bird|Nankeen Kestrel'] } });
    addImageEntity(crate, { path: 'b.jpg' });

    const reloaded = loadOrCreateCrate(serializeCrate(crate));
    expect(readImageRecord(reloaded, 'a.jpg').keywords.sort()).toEqual(['Bird', 'Nankeen Kestrel']);
    expect(readImageRecord(reloaded, 'b.jpg').keywords).toEqual([]);
  });

  it('reconstructs a rating, and defaults to null when none was recorded', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { Rating: 4 } });
    addImageEntity(crate, { path: 'b.jpg' });

    const reloaded = loadOrCreateCrate(serializeCrate(crate));
    expect(readImageRecord(reloaded, 'a.jpg').rating).toEqual(4);
    expect(readImageRecord(reloaded, 'b.jpg').rating).toBeNull();
  });

  it('reconstructs people and pets from the resolved about references, telling them apart by entity type', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'a.jpg',
      exif: {
        Regions: {
          RegionList: [
            { Name: 'Peter Malcolm Sefton', Type: 'Face' },
            { Name: 'Rex', Type: 'Pet' },
          ],
        },
      },
    });
    addImageEntity(crate, { path: 'b.jpg' });

    const reloaded = loadOrCreateCrate(serializeCrate(crate));
    expect(readImageRecord(reloaded, 'a.jpg').people).toEqual(['Peter Malcolm Sefton']);
    expect(readImageRecord(reloaded, 'a.jpg').pets).toEqual(['Rex']);
    expect(readImageRecord(reloaded, 'b.jpg').people).toEqual([]);
    expect(readImageRecord(reloaded, 'b.jpg').pets).toEqual([]);
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

describe('addImageEntity rating', () => {
  it('records a star rating of 1 or higher on the entity and in the returned record', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, { path: 'photo.jpg', exif: { Rating: 5 } });

    expect(record.rating).toEqual(5);
    expect(crate.getEntity('photo.jpg').rating).toEqual([5]);
  });

  it('does not set a rating when it is 0, absent, or EXIF failed', () => {
    const crate = loadOrCreateCrate(null);
    const zero = addImageEntity(crate, { path: 'a.jpg', exif: { Rating: 0 } });
    const absent = addImageEntity(crate, { path: 'b.jpg', exif: { Make: 'Acme' } });
    const failed = addImageEntity(crate, { path: 'c.jpg', exif: { Rating: 5 }, exifError: 'bad file' });

    expect(zero.rating).toBeNull();
    expect(absent.rating).toBeNull();
    expect(failed.rating).toBeNull();
    expect(crate.getEntity('a.jpg').rating).toBeUndefined();
    expect(crate.getEntity('b.jpg').rating).toBeUndefined();
    expect(crate.getEntity('c.jpg').rating).toBeUndefined();
  });
});

describe('addImageEntity title and description', () => {
  it('uses the IPTC ObjectName / XMP dc:title as the title when present', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, { path: 'photo.jpg', exif: { ObjectName: 'Sunset over the lake' } });

    expect(record.title).toEqual('Sunset over the lake');
    expect(crate.getEntity('photo.jpg').title).toEqual(['Sunset over the lake']);
  });

  it('falls back to the filename as the title when there is no IPTC/XMP title', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, { path: 'sub/photo.jpg', exif: { Make: 'Acme' } });

    expect(record.title).toEqual('photo.jpg');
    expect(crate.getEntity('sub/photo.jpg').title).toEqual(['photo.jpg']);
  });

  it('falls back to the filename as the title even when EXIF extraction failed entirely', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, { path: 'photo.jpg', exifError: 'bad file' });

    expect(record.title).toEqual('photo.jpg');
    expect(crate.getEntity('photo.jpg').title).toEqual(['photo.jpg']);
  });

  it('records a real IPTC/XMP caption as description, independent of any processingError', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, { path: 'photo.jpg', exif: { Caption: 'A heron at the lake' } });

    expect(record.description).toEqual('A heron at the lake');
    expect(record.processingError).toBeNull();
    expect(crate.getEntity('photo.jpg').description).toEqual(['A heron at the lake']);
  });

  it('leaves description unset when there is no caption, unlike title which always has a fallback', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });

    expect(record.description).toBeNull();
    expect(crate.getEntity('photo.jpg').description).toBeUndefined();
  });

  it('clears a stale description on rescan once the file no longer has a caption', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Caption: 'A heron at the lake' } });
    expect(crate.getEntity('photo.jpg').description).toEqual(['A heron at the lake']);

    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });
    expect(crate.getEntity('photo.jpg').description).toBeUndefined();
  });
});

describe('addImageEntity people and pets', () => {
  it('records a named face region as a Person entity, linked from the image via about', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Regions: { RegionList: { Name: 'Peter Malcolm Sefton', Type: 'Face' } } },
    });

    expect(record.people).toEqual(['Peter Malcolm Sefton']);
    expect(record.pets).toEqual([]);
    const about = crate.getEntity('photo.jpg').about;
    expect(about).toHaveLength(1);
    const person = crate.getEntity(about[0]['@id']);
    expect(person['@type']).toEqual(['Person']);
    expect(person.name).toEqual(['Peter Malcolm Sefton']);
  });

  it('records a named pet region as a separate Pet entity, distinct from a person of the same name', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { Regions: { RegionList: { Name: 'Max', Type: 'Pet' } } } });
    addImageEntity(crate, { path: 'b.jpg', exif: { Regions: { RegionList: { Name: 'Max', Type: 'Face' } } } });

    const petAbout = crate.getEntity('a.jpg').about[0]['@id'];
    const personAbout = crate.getEntity('b.jpg').about[0]['@id'];
    expect(petAbout).not.toEqual(personAbout);
    expect(crate.getEntity(petAbout)['@type']).toEqual(['Pet']);
    expect(crate.getEntity(personAbout)['@type']).toEqual(['Person']);
  });

  it('excludes a region\'s name from keywords, since tagging tools write the same name into both', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, {
      path: 'photo.jpg',
      exif: {
        hierarchicalSubject: ['Bird', 'Peter Malcolm Sefton'],
        Regions: { RegionList: { Name: 'Peter Malcolm Sefton', Type: 'Face' } },
      },
    });

    expect(record.keywords).toEqual(['Bird']);
    expect(record.people).toEqual(['Peter Malcolm Sefton']);
  });

  it('reuses the same Person entity across two images that depict them', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } } });
    addImageEntity(crate, { path: 'b.jpg', exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } } });

    expect(crate.getEntity('a.jpg').about[0]['@id']).toEqual(crate.getEntity('b.jpg').about[0]['@id']);
  });

  it('clears a stale keywords property on rescan when a photo\'s only keyword was a name now recorded as a person instead', () => {
    // Regression: an earlier version only ever assigned entity.keywords
    // when the freshly-computed list was non-empty, so a photo whose one
    // and only keyword was a person's name kept that name in `keywords`
    // forever after the name was excluded and moved into `about` — the
    // very case this feature exists to fix, not just a rare edge case.
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Keywords: ['Gail McGlinn'] } });
    expect(crate.getEntity('photo.jpg').keywords).toEqual(['Gail McGlinn']);

    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Keywords: ['Gail McGlinn'], Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } },
    });
    expect(crate.getEntity('photo.jpg').keywords).toBeUndefined();
    expect(readImageRecord(crate, 'photo.jpg').keywords).toEqual([]);
    expect(readImageRecord(crate, 'photo.jpg').people).toEqual(['Gail McGlinn']);
  });

  it('records a region\'s bounding box as its own ImageRegion entity, linked from the image via regions', () => {
    const crate = loadOrCreateCrate(null);
    const record = addImageEntity(crate, {
      path: 'photo.jpg',
      exif: {
        Regions: { RegionList: { Name: 'Peter Malcolm Sefton', Type: 'Face', Area: { x: 0.57, y: 0.23, w: 0.29, h: 0.27 } } },
      },
    });

    expect(record.regions).toEqual([{ name: 'Peter Malcolm Sefton', nameInFile: null, type: 'Face', area: { x: 0.57, y: 0.23, w: 0.29, h: 0.27 } }]);

    const regionRefs = crate.getEntity('photo.jpg').regions;
    expect(regionRefs).toHaveLength(1);
    const region = crate.getEntity(regionRefs[0]['@id']);
    expect(region['@type']).toEqual(['ImageRegion']);
    expect(region.name).toEqual(['Peter Malcolm Sefton']);
    expect(region.regionType).toEqual(['Face']);
    expect(region.xPosition).toEqual([0.57]);
    expect(region.about[0]['@id']).toEqual(crate.getEntity('photo.jpg').about[0]['@id']);
  });

  it('records a region with no bounding box (area not recorded by the tagging tool) without x/y/w/h properties', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } } });

    const region = crate.getEntity(crate.getEntity('photo.jpg').regions[0]['@id']);
    expect(region.xPosition).toBeUndefined();
  });

  it('clears a stale regions property on rescan once a photo\'s regions are gone', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } } });
    expect(crate.getEntity('photo.jpg').regions).toHaveLength(1);

    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });
    expect(crate.getEntity('photo.jpg').regions).toBeUndefined();
  });

  it('reconstructs regions, including the bounding box, from the resolved ImageRegion references', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face', Area: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } } } },
    });

    const reloaded = loadOrCreateCrate(serializeCrate(crate));
    expect(readImageRecord(reloaded, 'photo.jpg').regions).toEqual([
      { name: 'Gail McGlinn', nameInFile: null, type: 'Face', area: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    ]);
  });
});

describe('addStandoffFaceRegion', () => {
  it('records a confirmed face as a standoff region, readable back with a centre-based area like an EXIF-derived one', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });

    const subjectId = personEntityId('Jane Smith');
    const result = addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId, subjectType: 'Person',
      box: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 }, // face-api.js's own top-left shape
    });

    expect(result.regionId).toEqual('photo.jpg#region-standoff-0');
    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.people).toEqual(['Jane Smith']);
    expect(record.regions).toEqual([
      { name: 'Jane Smith', nameInFile: null, type: 'Face', area: { x: 0.5, y: 0.4, w: 0.2, h: 0.2 } }, // converted to centre-based
    ]);

    const region = crate.getEntity(result.regionId);
    expect(region['@type']).toEqual(expect.arrayContaining(['ImageRegion', 'oa:Annotation']));
    expect(region.writtenToFile).toEqual([false]);
    expect(region['oa:motivatedBy'][0]['@id']).toEqual('oa:identifying');
    // oa:hasBody names the Person itself, which is what an identifying
    // annotation means, rather than a proxy that only points at them.
    expect(region['oa:hasBody'][0]['@id']).toEqual(subjectId);
    expect(crate.getEntity(subjectId).name).toEqual(['Jane Smith']);
    expect(crate.getEntity(`${result.regionId}-body`)).toBeUndefined();
  });

  it('gives each standoff region on the same image its own id, not colliding with the next', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });

    const first = addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });
    const second = addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Bob Jones', subjectId: personEntityId('Bob Jones'), subjectType: 'Person', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    });

    expect(first.regionId).not.toEqual(second.regionId);
    expect(readImageRecord(crate, 'photo.jpg').people.sort()).toEqual(['Bob Jones', 'Jane Smith']);
  });

  it('returns null for an image with no entity yet, rather than throwing', () => {
    const crate = loadOrCreateCrate(null);
    expect(addStandoffFaceRegion(crate, 'nope.jpg', { name: 'X', subjectId: 'x', subjectType: 'Person', box: { x: 0, y: 0, w: 0.1, h: 0.1 } })).toBeNull();
  });

  it('survives a rescan (addImageEntity) that finds no EXIF regions of its own', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 },
    });

    // A routine rescan of the same, still-untagged-in-EXIF file must not
    // silently drop the standoff confirmation — the whole point of it
    // being independent of the file in the first place.
    addImageEntity(crate, { path: 'photo.jpg', exif: { Make: 'Acme' } });

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.people).toEqual(['Jane Smith']);
    expect(record.regions).toHaveLength(1);
  });

  it('is superseded, not duplicated, once the same name appears in a fresh EXIF-derived region', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    const standoff = addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 },
    });
    const bodyId = crate.getEntity(standoff.regionId)['oa:hasBody'][0]['@id'];
    expect(bodyId).toEqual(personEntityId('Jane Smith'));

    // Write-back (or another tool) has since tagged the same person for
    // real - the next rescan picks that up from EXIF.
    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Regions: { RegionList: { Name: 'Jane Smith', Type: 'Face', Area: { x: 0.5, y: 0.4, w: 0.2, h: 0.2 } } } },
    });

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.people).toEqual(['Jane Smith']); // not ['Jane Smith', 'Jane Smith']
    expect(record.regions).toHaveLength(1);
    // The superseded standoff region is cleaned up, not left dangling.
    expect(crate.getEntity(standoff.regionId)).toBeUndefined();
    // Its body is the shared Person, which the EXIF region now depicts
    // and which other photos in this crate may also depict: removing
    // the region must not take them with it.
    expect(crate.getEntity(bodyId)).toBeTruthy();
  });

  it('removes the body proxy of a superseded region written before bodies named the person directly', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    const standoff = addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 },
    });
    // Put the old shape back: a proxy owned by this one region.
    const proxyId = `${standoff.regionId}-body`;
    crate.addEntity({ '@id': proxyId, '@type': 'Person', 'prov:specializationOf': { '@id': personEntityId('Jane Smith') } });
    crate.getEntity(standoff.regionId)['oa:hasBody'] = { '@id': proxyId };

    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Regions: { RegionList: { Name: 'Jane Smith', Type: 'Face', Area: { x: 0.5, y: 0.4, w: 0.2, h: 0.2 } } } },
    });

    expect(crate.getEntity(standoff.regionId)).toBeUndefined();
    expect(crate.getEntity(proxyId)).toBeUndefined();
    expect(crate.getEntity(personEntityId('Jane Smith'))).toBeTruthy();
  });

  it('leaves an unrelated standoff region for a different person alone when another name is superseded', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });
    addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Bob Jones', subjectId: personEntityId('Bob Jones'), subjectType: 'Person', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    });

    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Regions: { RegionList: { Name: 'Jane Smith', Type: 'Face', Area: { x: 0.15, y: 0.15, w: 0.1, h: 0.1 } } } },
    });

    expect(readImageRecord(crate, 'photo.jpg').people.sort()).toEqual(['Bob Jones', 'Jane Smith']);
  });

  it('records a standoff pet region under its own Pet entity, distinct from a person of the same name', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Max', subjectId: petEntityId('Max'), subjectType: 'Pet', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.pets).toEqual(['Max']);
    expect(record.people).toEqual([]);
  });
});

describe('setImageKeywords', () => {
  it('replaces whatever keywords were there, independent of EXIF', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Keywords: ['Bird'] } });

    setImageKeywords(crate, 'photo.jpg', ['Bird', 'Sunset']);
    expect(readImageRecord(crate, 'photo.jpg').keywords.sort()).toEqual(['Bird', 'Sunset']);
  });

  it('clears a previously-set keywords property rather than leaving it stale', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Keywords: ['Bird'] } });

    setImageKeywords(crate, 'photo.jpg', []);
    expect(crate.getEntity('photo.jpg').keywords).toBeUndefined();
  });

  it('does nothing for an image with no entity yet', () => {
    const crate = loadOrCreateCrate(null);
    expect(() => setImageKeywords(crate, 'nonexistent.jpg', ['Bird'])).not.toThrow();
  });
});

describe('setImageRating', () => {
  it('sets a rating independent of EXIF', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg' });

    setImageRating(crate, 'photo.jpg', 4);
    expect(readImageRecord(crate, 'photo.jpg').rating).toEqual(4);
  });

  it('clears a previously-set rating rather than leaving it stale', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Rating: 5 } });

    setImageRating(crate, 'photo.jpg', null);
    expect(crate.getEntity('photo.jpg').rating).toBeUndefined();
  });
});

describe('setImageTitle', () => {
  it('sets a title independent of EXIF', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg' });

    setImageTitle(crate, 'photo.jpg', 'My holiday photo');
    expect(readImageRecord(crate, 'photo.jpg').title).toEqual('My holiday photo');
  });

  it('falls back to the filename rather than leaving the title blank when cleared', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { ObjectName: 'My holiday photo' } });

    setImageTitle(crate, 'photo.jpg', '');
    expect(readImageRecord(crate, 'photo.jpg').title).toEqual('photo.jpg');
  });
});

describe('setImageDescription', () => {
  it('sets a description independent of EXIF', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg' });

    setImageDescription(crate, 'photo.jpg', 'A heron at the lake');
    expect(readImageRecord(crate, 'photo.jpg').description).toEqual('A heron at the lake');
  });

  it('clears a previously-set description rather than leaving it stale', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Caption: 'A heron at the lake' } });

    setImageDescription(crate, 'photo.jpg', null);
    expect(crate.getEntity('photo.jpg').description).toBeUndefined();
  });
});

describe('removeImageEntity', () => {
  it('removes the entity, its hasPart reference, and its own EXIF and region nodes', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { Make: 'Acme', Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } },
      thumbnailPath: 'thumbnails/photo.jpg.thumb.jpg',
    });

    removeImageEntity(crate, 'photo.jpg');

    expect(crate.getEntity('photo.jpg')).toBeUndefined();
    expect(crate.getEntity('photo.jpg#exif-Make')).toBeUndefined();
    expect(crate.getEntity('photo.jpg#region-0')).toBeUndefined();
    expect(crate.getEntity('thumbnails/photo.jpg.thumb.jpg')).toBeUndefined();
    expect(crate.rootDataset.hasPart?.some((ref) => ref['@id'] === 'photo.jpg')).toBeFalsy();
  });

  it('removes a standoff region but not the Person its body names, which other photos also depict', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    addImageEntity(crate, { path: 'other.jpg', exif: { Regions: { RegionList: { Name: 'Jane Smith', Type: 'Face' } } } });
    const { regionId } = addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });

    removeImageEntity(crate, 'photo.jpg');

    expect(crate.getEntity(regionId)).toBeUndefined();
    expect(crate.getEntity(personEntityId('Jane Smith'))).toBeTruthy();
    expect(crate.getEntity('other.jpg').about[0]['@id']).toEqual(personEntityId('Jane Smith'));
  });

  it('removes a body proxy written before bodies named the person directly, but still not the person', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    const { regionId } = addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'Jane Smith', subjectId: personEntityId('Jane Smith'), subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });
    const proxyId = `${regionId}-body`;
    crate.addEntity({ '@id': proxyId, '@type': 'Person', 'prov:specializationOf': { '@id': personEntityId('Jane Smith') } });
    crate.getEntity(regionId)['oa:hasBody'] = { '@id': proxyId };

    removeImageEntity(crate, 'photo.jpg');

    expect(crate.getEntity(proxyId)).toBeUndefined();
    expect(crate.getEntity(personEntityId('Jane Smith'))).toBeTruthy();
  });

  it('leaves the Person/Pet entity it depicted alone, since another image may still depict them', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } } });
    addImageEntity(crate, { path: 'b.jpg', exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face' } } } });
    const personId = crate.getEntity('a.jpg').about[0]['@id'];

    removeImageEntity(crate, 'a.jpg');

    expect(crate.getEntity(personId)).toBeTruthy();
    expect(crate.getEntity('b.jpg').about[0]['@id']).toEqual(personId);
  });

  it('does nothing for an image with no entity yet', () => {
    const crate = loadOrCreateCrate(null);
    expect(() => removeImageEntity(crate, 'nonexistent.jpg')).not.toThrow();
  });
});

describe('renamePersonInCrate', () => {
  const sourceId = personEntityId('jane smith');
  const targetId = personEntityId('Jane Smith');
  const renameArgs = { sourceId, sourceName: 'jane smith', targetId, targetName: 'Jane Smith', subjectType: 'Person' };

  it('re-points an EXIF-derived region (and the image\'s own about) at the target identity', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Regions: { RegionList: { Name: 'jane smith', Type: 'Face', Area: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } } } });

    const changed = renamePersonInCrate(crate, 'photo.jpg', renameArgs);

    expect(changed).toBe(true);
    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.people).toEqual(['Jane Smith']);
    expect(record.regions).toEqual([{ name: 'Jane Smith', nameInFile: null, type: 'Face', area: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }]);
    expect(crate.getEntity('photo.jpg').about[0]['@id']).toEqual(targetId);
    expect(crate.getEntity(targetId).name).toEqual(['Jane Smith']);
    // No instance is coined on the way: one exists only where somebody
    // deliberately recorded a local name.
    expect(crate.getEntity('#person-JaneSmith')).toBeUndefined();
  });

  it('re-points a standoff region\'s body-proxy specialization', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    addStandoffFaceRegion(crate, 'photo.jpg', {
      name: 'jane smith', subjectId: sourceId, subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });

    renamePersonInCrate(crate, 'photo.jpg', renameArgs);

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.people).toEqual(['Jane Smith']);
    expect(record.regions[0].name).toEqual('Jane Smith');
  });

  it('dedupes the image\'s about array if it somehow already referenced both identities', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: {} });
    crate.addEntity({ '@id': sourceId, '@type': 'Person', name: 'jane smith' }, { replace: true });
    crate.addEntity({ '@id': targetId, '@type': 'Person', name: 'Jane Smith' }, { replace: true });
    crate.addValues('photo.jpg', 'about', [{ '@id': sourceId }, { '@id': targetId }]);

    renamePersonInCrate(crate, 'photo.jpg', renameArgs);

    expect(crate.getEntity('photo.jpg').about).toHaveLength(1);
    expect(crate.getEntity('photo.jpg').about[0]['@id']).toEqual(targetId);
  });

  it('is a no-op, returning false, for an image that never referenced the source identity', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: { Regions: { RegionList: { Name: 'Someone Else', Type: 'Face' } } } });

    const changed = renamePersonInCrate(crate, 'photo.jpg', renameArgs);

    expect(changed).toBe(false);
    expect(readImageRecord(crate, 'photo.jpg').people).toEqual(['Someone Else']);
  });

  it('also moves a crate written before instances existed, migrating its reference on the way past', () => {
    // A scan only rewrites an image whose file changed, so an old-shape
    // reference straight to the arcp id can persist indefinitely; a
    // merge that skipped those would silently do nothing for them.
    const crate = loadOrCreateCrate(JSON.stringify({
      '@context': ['https://w3id.org/ro/crate/1.2/context', { '@vocab': 'http://schema.org/' }],
      '@graph': [
        { '@id': './', '@type': 'Dataset', name: '2005', hasPart: { '@id': 'photo.jpg' } },
        { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
        { '@id': sourceId, '@type': 'Person', name: 'jane smith' },
        { '@id': 'photo.jpg#region-0', '@type': 'ImageRegion', name: 'jane smith', regionType: 'Face', about: { '@id': sourceId } },
        { '@id': 'photo.jpg', '@type': 'ImageObject', name: 'photo.jpg', about: [{ '@id': sourceId }], regions: [{ '@id': 'photo.jpg#region-0' }] },
      ],
    }));

    expect(renamePersonInCrate(crate, 'photo.jpg', renameArgs)).toBe(true);

    expect(crate.getEntity('photo.jpg').about.map((ref) => ref['@id'])).toEqual([targetId]);
    expect(unwrapId(crate.getEntity('photo.jpg#region-0').about)).toEqual(targetId);
    expect(readImageRecord(crate, 'photo.jpg').people).toEqual(['Jane Smith']);
  });

  it('is a no-op for an image with no entity yet, rather than throwing', () => {
    const crate = loadOrCreateCrate(null);
    expect(() => renamePersonInCrate(crate, 'nope.jpg', renameArgs)).not.toThrow();
  });
});

describe('Person/Pet references', () => {
  it('points an image and its EXIF region straight at the shared identity', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { Regions: { RegionList: { Name: 'Jane Smith', Type: 'Face', Area: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 } } } } });

    const janeId = personEntityId('Jane Smith');
    expect(crate.getEntity('a.jpg').about[0]['@id']).toEqual(janeId);
    expect(unwrapId(crate.getEntity('a.jpg#region-0').about)).toEqual(janeId);

    // The identity is copied into this crate so it reads standalone,
    // carrying its name and nothing else — the root crate's copy is the
    // one that holds a description or a birth date.
    const person = crate.getEntity(janeId);
    expect(person['@type']).toEqual(['Person']);
    expect(person.name).toEqual(['Jane Smith']);

    // No per-crate instance is coined. One exists only where somebody
    // deliberately recorded a different local name, so its presence is
    // the statement that the difference is meant.
    expect(crate.getEntity('#person-JaneSmith')).toBeUndefined();
  });

  it('keeps a Person and a Pet of the same name apart', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: { Regions: { RegionList: [
      { Name: 'Rex', Type: 'Face' }, { Name: 'Rex', Type: 'Pet' },
    ] } } });

    expect(crate.getEntity('a.jpg').about.map((ref) => ref['@id']).sort())
      .toEqual([personEntityId('Rex'), petEntityId('Rex')].sort());
    expect(crate.getEntity(petEntityId('Rex'))['@type']).toEqual(['Pet']);
  });

  it('records the identity once however many photos in the crate depict them', () => {
    const crate = loadOrCreateCrate(null);
    for (const path of ['a.jpg', 'b.jpg']) {
      addImageEntity(crate, { path, exif: { Regions: { RegionList: { Name: 'Jane Smith', Type: 'Face' } } } });
    }

    const janeId = personEntityId('Jane Smith');
    expect(crate.getEntity('a.jpg').about[0]['@id']).toEqual(janeId);
    expect(crate.getEntity('b.jpg').about[0]['@id']).toEqual(janeId);
    expect(crate.toJSON()['@graph'].filter((e) => e['@id'] === janeId)).toHaveLength(1);
  });

  it('reads back the name of a person a crate written earlier reaches through an instance', () => {
    // Nothing writes this shape now, but crates full of it exist and a
    // scan only rewrites an image whose file actually changed.
    const crate = loadOrCreateCrate(JSON.stringify({
      '@context': ['https://w3id.org/ro/crate/1.2/context', { '@vocab': 'http://schema.org/' }],
      '@graph': [
        { '@id': './', '@type': 'Dataset', name: '2005', hasPart: { '@id': 'a.jpg' } },
        { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' }, conformsTo: { '@id': 'https://w3id.org/ro/crate/1.2' } },
        { '@id': personEntityId('Jane Smith'), '@type': 'Person', name: 'Jane Smith' },
        { '@id': '#person-JaneSmith', '@type': 'Person', name: 'Jane Smith', 'prov:specializationOf': { '@id': personEntityId('Jane Smith') } },
        { '@id': 'a.jpg', '@type': 'ImageObject', name: 'a.jpg', about: [{ '@id': '#person-JaneSmith' }] },
      ],
    }));

    expect(readImageRecord(crate, 'a.jpg').people).toEqual(['Jane Smith']);
    expect(subjectInstanceId('Jane Smith', 'Person')).toEqual('#person-JaneSmith');
  });

  it('keeps a preserved standoff region pointing at the person across a rescan', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'a.jpg', exif: {} });
    addStandoffFaceRegion(crate, 'a.jpg', {
      name: 'Bob Jones', subjectId: personEntityId('Bob Jones'), subjectType: 'Person', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });
    addImageEntity(crate, { path: 'a.jpg', exif: {} }); // rescan, still no EXIF regions

    expect(crate.getEntity('a.jpg').about.map((ref) => ref['@id'])).toEqual([personEntityId('Bob Jones')]);
    expect(readImageRecord(crate, 'a.jpg').people).toEqual(['Bob Jones']);
  });
});

describe('a name this crate already records, against what the file says', () => {
  const area = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
  const exifWith = (Name, Area = area) => ({ Regions: { RegionList: { Name, Type: 'Face', Area } } });

  it('keeps the crate\'s name when the file disagrees, and records what the file says', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('jane smith') });
    renamePersonInCrate(crate, 'photo.jpg', {
      sourceId: personEntityId('jane smith'), sourceName: 'jane smith',
      targetId: personEntityId('Jane Smith'), targetName: 'Jane Smith', subjectType: 'Person',
    });

    // --reprocess: the file was never written to, so its EXIF still
    // carries the old spelling. Re-deriving from it would undo the
    // rename without saying so.
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('jane smith') });

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.people).toEqual(['Jane Smith']);
    expect(record.regions).toEqual([{ name: 'Jane Smith', nameInFile: 'jane smith', type: 'Face', area }]);
    expect(crate.getEntity('photo.jpg').about[0]['@id']).toEqual(personEntityId('Jane Smith'));
  });

  it('stops recording the disagreement once the file has caught up', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('jane smith') });
    renamePersonInCrate(crate, 'photo.jpg', {
      sourceId: personEntityId('jane smith'), sourceName: 'jane smith',
      targetId: personEntityId('Jane Smith'), targetName: 'Jane Smith', subjectType: 'Person',
    });
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('jane smith') });
    expect(readImageRecord(crate, 'photo.jpg').regions[0].nameInFile).toEqual('jane smith');

    // Write-back has since put the new name in the file, and
    // rescanImageMetadata re-reads it (see scanImage.js).
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('Jane Smith') });

    expect(readImageRecord(crate, 'photo.jpg').regions[0].nameInFile).toBeNull();
    expect(crate.getEntity('photo.jpg#region-0').nameInFile).toBeUndefined();
  });

  it('takes the file\'s name for a region that has moved, which is a different tag', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('Jane Smith') });

    // Re-tagged in another tool: a different box, so there is no local
    // edit to protect and the file is the only thing that knows.
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('Bob Jones', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }) });

    const record = readImageRecord(crate, 'photo.jpg');
    expect(record.people).toEqual(['Bob Jones']);
    expect(record.regions[0].nameInFile).toBeNull();
  });

  it('keeps the old name out of the keywords, which the tagging tool also writes it into', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, { path: 'photo.jpg', exif: exifWith('jane smith') });
    renamePersonInCrate(crate, 'photo.jpg', {
      sourceId: personEntityId('jane smith'), sourceName: 'jane smith',
      targetId: personEntityId('Jane Smith'), targetName: 'Jane Smith', subjectType: 'Person',
    });

    const record = addImageEntity(crate, {
      path: 'photo.jpg',
      exif: { ...exifWith('jane smith'), Keywords: ['jane smith', 'holiday'] },
    });

    expect(record.keywords).toEqual(['holiday']);
  });
});

describe('syncRootCrateSubjects', () => {
  it('records each identity once, without linking it from the root dataset', () => {
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'Jane Smith', subjectType: 'Person' }, { name: 'Rex', subjectType: 'Pet' }]);
    syncRootCrateSubjects(crate, [{ name: 'Jane Smith', subjectType: 'Person' }, { name: 'Rex', subjectType: 'Pet' }]);

    expect(crate.rootDataset.mentions).toBeUndefined();
    expect(crate.getEntity(personEntityId('Jane Smith'))['@type']).toEqual(['Person']);
    expect(crate.getEntity(petEntityId('Rex'))['@type']).toEqual(['Pet']);
    expect(crate.toJSON()['@graph'].filter((e) => e['@id'] === personEntityId('Jane Smith'))).toHaveLength(1);
  });

  it('keeps whatever else has been recorded about someone — the reason the root crate holds them at all', () => {
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'Jane Smith', subjectType: 'Person' }]);
    crate.getEntity(personEntityId('Jane Smith')).birthDate = '1984-02-03';

    syncRootCrateSubjects(crate, [{ name: 'Jane Smith', subjectType: 'Person' }]);

    expect(crate.getEntity(personEntityId('Jane Smith')).birthDate).toEqual(['1984-02-03']);
  });

  it('drops an identity no longer depicted anywhere, when its name is all this function ever wrote', () => {
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'jane smith', subjectType: 'Person' }, { name: 'Jane Smith', subjectType: 'Person' }]);

    syncRootCrateSubjects(crate, [{ name: 'Jane Smith', subjectType: 'Person' }]);

    expect(crate.getEntity(personEntityId('jane smith'))).toBeUndefined();
    expect(crate.getEntity(personEntityId('Jane Smith'))).toBeTruthy();
  });

  it('drops one an older crate still lists on mentions, and the mention with it', () => {
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'jane smith', subjectType: 'Person' }]);
    crate.addValues(crate.rootId, 'mentions', { '@id': personEntityId('jane smith') });

    syncRootCrateSubjects(crate, []);

    expect(crate.getEntity(personEntityId('jane smith'))).toBeUndefined();
    expect(crate.rootDataset.mentions ?? []).toEqual([]);
  });

  it('leaves alone a Person somebody else points at, and one that is not a bare identity', () => {
    const crate = loadOrCreateCrate(null);
    crate.addEntity({ '@id': '#photographer', '@type': 'Person', name: 'Pat' });
    crate.addValues(crate.rootId, 'author', { '@id': '#photographer' });

    syncRootCrateSubjects(crate, []);

    expect(crate.getEntity('#photographer')).toBeTruthy();
  });

  it('keeps an identity nothing depicts once somebody has written something about them', () => {
    // A region removed in another tool, the last photo of someone put
    // in the trash, or a person written down before any photo of them
    // was tagged. A scan cannot reconstruct a description from photos,
    // so deleting the node would destroy the only copy.
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'Great Aunt Mabel', subjectType: 'Person' }]);
    crate.getEntity(personEntityId('Great Aunt Mabel')).description = 'Emigrated 1952. Never photographed.';

    syncRootCrateSubjects(crate, []);

    const mabel = crate.getEntity(personEntityId('Great Aunt Mabel'));
    expect(mabel.description).toEqual(['Emigrated 1952. Never photographed.']);
  });
});

describe('foldSubjectInto', () => {
  const sourceId = personEntityId('jane smith');
  const targetId = personEntityId('Jane Smith');

  it('removes a merged-away identity even though a description would otherwise protect it', () => {
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'jane smith', subjectType: 'Person' }, { name: 'Jane Smith', subjectType: 'Person' }]);
    crate.getEntity(sourceId).description = 'Gran';

    foldSubjectInto(crate, { sourceId, targetId });

    expect(crate.getEntity(sourceId)).toBeUndefined();
    expect(crate.getEntity(targetId)).toBeTruthy();
  });

  it('carries what the merged-away record knew over to the survivor', () => {
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'jane smith', subjectType: 'Person' }, { name: 'Jane Smith', subjectType: 'Person' }]);
    crate.getEntity(sourceId).description = 'Gran';
    crate.getEntity(sourceId).birthDate = '1948';

    foldSubjectInto(crate, { sourceId, targetId });

    expect(crate.getEntity(targetId).description).toEqual(['Gran']);
    expect(crate.getEntity(targetId).birthDate).toEqual(['1948']);
  });

  it('never overwrites something the survivor already says', () => {
    const crate = loadOrCreateCrate(null);
    syncRootCrateSubjects(crate, [{ name: 'jane smith', subjectType: 'Person' }, { name: 'Jane Smith', subjectType: 'Person' }]);
    crate.getEntity(sourceId).description = 'the older note';
    crate.getEntity(targetId).description = 'the one being kept';

    foldSubjectInto(crate, { sourceId, targetId });

    expect(crate.getEntity(targetId).description).toEqual(['the one being kept']);
    expect(crate.getEntity(targetId).name).toEqual(['Jane Smith']);
  });
});

// Reads a property that may come back as a one-element array under
// { array: true } (see crateBuilder's own unwrap).
function unwrapId(value) {
  return (Array.isArray(value) ? value[0] : value)?.['@id'];
}
