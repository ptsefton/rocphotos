import { describe, it, expect } from 'vitest';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import {
  resolveSubjectId,
  subjectIdInCrate,
  mintSubjectId,
  subjectLookupFromIndex,
  resolveSubjectIdFromIndex,
} from '../src/core/subjects.js';
import { loadOrCreateCrate, addImageEntity, renameSubjectInCrate, readImageRecord } from '../src/core/crateBuilder.js';
import {
  ensureSchema, upsertRoCrate, upsertEntity, crateEntityId, personEntityId, petEntityId,
  ENTITY_TYPE_PERSON, ENTITY_TYPE_PET, ENTITY_TYPE_COLLECTION,
} from '../src/core/db/store.js';

const GAIL = personEntityId('Gail McGlinn');

function crateWithPerson(id, name) {
  const crate = loadOrCreateCrate(null);
  crate.addEntity({ '@id': id, '@type': 'Person', name });
  return crate;
}

describe('subjectIdInCrate', () => {
  it('finds somebody by the name they go by now, not by what their id looks like', () => {
    // The id was minted from "Gail McGlinn" and frozen; she has since
    // been renamed. Matching on the id would be matching on history.
    const crate = crateWithPerson(GAIL, 'Gail Q. McGlinn');

    expect(subjectIdInCrate(crate, 'Gail Q. McGlinn', 'Person')).toEqual(GAIL);
    expect(subjectIdInCrate(crate, 'Gail McGlinn', 'Person')).toBeNull();
  });

  it('keeps people and pets apart', () => {
    const crate = crateWithPerson(personEntityId('Rex'), 'Rex');
    crate.addEntity({ '@id': petEntityId('Rex'), '@type': 'Pet', name: 'Rex' });

    expect(subjectIdInCrate(crate, 'Rex', 'Person')).toEqual(personEntityId('Rex'));
    expect(subjectIdInCrate(crate, 'Rex', 'Pet')).toEqual(petEntityId('Rex'));
  });

  it('ignores a per-crate instance, which is not an identity of its own', () => {
    // An older crate reaches the identity through one of these; the
    // thing to reference is what it specializes.
    const crate = crateWithPerson(GAIL, 'Gail McGlinn');
    crate.addEntity({ '@id': '#person-GailMcGlinn', '@type': 'Person', name: 'Gail McGlinn', 'prov:specializationOf': { '@id': GAIL } });

    expect(subjectIdInCrate(crate, 'Gail McGlinn', 'Person')).toEqual(GAIL);
  });
});

describe('resolveSubjectId', () => {
  it('prefers what the crate already uses, so a rescan needs nothing else', () => {
    const crate = crateWithPerson(GAIL, 'Gail Q. McGlinn');
    const lookup = () => 'arcp://name,rocphoto/person/SomebodyElse';

    expect(resolveSubjectId('Gail Q. McGlinn', 'Person', { crate, lookup })).toEqual(GAIL);
  });

  it('falls back to the collection, which is what links a person across crates', () => {
    const crate = loadOrCreateCrate(null);
    const lookup = (name) => (name === 'Gail Q. McGlinn' ? GAIL : null);

    expect(resolveSubjectId('Gail Q. McGlinn', 'Person', { crate, lookup })).toEqual(GAIL);
  });

  it('mints from the name only for somebody nothing has seen', () => {
    // And mints exactly what the old name-derived code computed, which
    // is why existing collections need no migration.
    expect(resolveSubjectId('Gail McGlinn', 'Person', {})).toEqual(GAIL);
    expect(resolveSubjectId('Gail McGlinn', 'Person', {})).toEqual(mintSubjectId('Gail McGlinn', 'Person'));
  });
});

describe('the index as a registry', () => {
  function indexWith(rows) {
    const db = openNodeSqlite(':memory:');
    ensureSchema(db);
    upsertRoCrate(db, { id: crateEntityId(''), path: '', name: 'root' });
    upsertEntity(db, { id: crateEntityId(''), roCrateId: crateEntityId(''), entityType: ENTITY_TYPE_COLLECTION, name: 'root' });
    for (const [id, name, type] of rows) {
      upsertEntity(db, { id, roCrateId: crateEntityId(''), entityType: type, name });
    }
    return db;
  }

  it('answers by current name, giving back the frozen id', () => {
    const db = indexWith([[GAIL, 'Gail Q. McGlinn', ENTITY_TYPE_PERSON], [petEntityId('Rex'), 'Rex', ENTITY_TYPE_PET]]);

    expect(subjectLookupFromIndex(db)('Gail Q. McGlinn', 'Person')).toEqual(GAIL);
    expect(subjectLookupFromIndex(db)('Rex', 'Pet')).toEqual(petEntityId('Rex'));
    expect(subjectLookupFromIndex(db)('Gail McGlinn', 'Person')).toBeNull();
    expect(resolveSubjectIdFromIndex(db, 'Gail Q. McGlinn')).toEqual(GAIL);
  });

  it('mints for a name it has never seen, rather than returning nothing', () => {
    expect(resolveSubjectIdFromIndex(indexWith([]), 'Brand New')).toEqual(personEntityId('Brand New'));
  });
});

describe('a rename, end to end through a crate', () => {
  it('changes every copy of the label and moves no identity', () => {
    const crate = loadOrCreateCrate(null);
    addImageEntity(crate, {
      path: 'a.jpg',
      exif: { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face', Area: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } } },
      sourceModifiedAt: 1,
    });

    expect(renameSubjectInCrate(crate, { subjectId: GAIL, newName: 'Gail Q. McGlinn' })).toBe(true);

    expect(crate.getEntity(GAIL).name).toEqual(['Gail Q. McGlinn']);
    expect(crate.getEntity(personEntityId('Gail Q. McGlinn'))).toBeUndefined();
    // The region's duplicated display name follows, and its reference
    // does not move — nothing had to be re-pointed.
    expect(crate.getEntity('a.jpg#region-0').name).toEqual(['Gail Q. McGlinn']);
    expect(crate.getEntity('a.jpg#region-0').about[0]['@id']).toEqual(GAIL);
    expect(readImageRecord(crate, 'a.jpg').people).toEqual(['Gail Q. McGlinn']);
    expect(readImageRecord(crate, 'a.jpg').subjects).toEqual([{ id: GAIL, name: 'Gail Q. McGlinn', subjectType: 'Person' }]);
  });

  it('survives a re-derive from EXIF that still carries the old name', () => {
    // The case that would have undone the rename: --reprocess reads the
    // file again, and the file was never written to. The crate's name
    // wins and the id is resolved from the crate, not recomputed.
    const crate = loadOrCreateCrate(null);
    const exif = { Regions: { RegionList: { Name: 'Gail McGlinn', Type: 'Face', Area: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } } } };
    addImageEntity(crate, { path: 'a.jpg', exif, sourceModifiedAt: 1 });
    renameSubjectInCrate(crate, { subjectId: GAIL, newName: 'Gail Q. McGlinn' });

    addImageEntity(crate, { path: 'a.jpg', exif, sourceModifiedAt: 2 });

    const record = readImageRecord(crate, 'a.jpg');
    expect(record.people).toEqual(['Gail Q. McGlinn']);
    expect(record.subjects[0].id).toEqual(GAIL);
    expect(record.regions[0].nameInFile).toEqual('Gail McGlinn');
    // No second identity was coined for the spelling in the file.
    expect(crate.getEntity(personEntityId('Gail McGlinn'))).toBeTruthy(); // the frozen id itself
    expect([...crate.entities()].filter((e) => [].concat(e['@type']).includes('Person'))).toHaveLength(1);
  });

  it('links somebody appearing in a new crate to the id the collection already uses', () => {
    const crate = loadOrCreateCrate(null);
    const lookup = (name) => (name === 'Gail Q. McGlinn' ? GAIL : null);

    addImageEntity(crate, {
      path: 'b.jpg',
      exif: { Regions: { RegionList: { Name: 'Gail Q. McGlinn', Type: 'Face' } } },
      subjectLookup: lookup,
    });

    expect(crate.getEntity('b.jpg').about[0]['@id']).toEqual(GAIL);
    expect(crate.getEntity(personEntityId('Gail Q. McGlinn'))).toBeUndefined();
  });
});
