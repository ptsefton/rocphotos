import { describe, it, expect } from 'vitest';
import { loadOrCreateCrate } from '../src/core/crateBuilder.js';
import { personEntityId } from '../src/core/db/store.js';
import { rocphotosProfileEditor, PERSON_RELATIONSHIP_CLASSES } from '../src/masp/rocphotosProfile.js';
import {
  participantFields, relationshipsFor, writeRelationship, deleteRelationship, mintRelationshipId,
  swappableParticipants,
} from '../src/core/people/relationships.js';

const RICO = 'https://www.ica.org/standards/RiC/ontology#';
const SPOUSE = '#SpouseRelationshipClass';
const PARENT_CHILD = '#ParentChildRelationshipClass';
const id = (name) => personEntityId(name);

function rootCrateWith(...names) {
  const crate = loadOrCreateCrate(null);
  crate.rootDataset.name = 'A collection';
  for (const name of names) {
    crate.addEntity({ '@id': id(name), '@type': 'Person', name });
    crate.addValues(crate.rootId, 'mentions', { '@id': id(name) });
  }
  return crate;
}

describe('a kind of relationship is a class, so it can explain itself', () => {
  const editor = rocphotosProfileEditor();

  it('states its own direction, rather than leaving it to a shared property', () => {
    // The reason these are classes and not DefinedTerms: a term has no
    // way to say which end plays which role, so the direction could
    // only be written as prose on a property every kind shared — true
    // of all of them by convention, guaranteed of none.
    //
    // Asserted on the participants rather than on the class gloss. Each
    // kind declares its own participant rules, so that is where a role
    // can be named at all — and it is what the form puts beside the
    // box. The class gloss is free to say what the relationship covers
    // without having to repeat which end is which.
    const [parent, child] = editor.fields(PARENT_CHILD);
    expect([parent.label, child.label]).toEqual(['Parent', 'Child']);
    expect(parent.help).toMatch(/the parent is its source/);
    expect(child.help).toMatch(/target of the relationship/);

    const [spouses] = editor.fields(SPOUSE);
    expect(spouses.help).toMatch(/Neither comes first/);
  });

  it('runs the way RiC runs it: down a generation, from the parent', () => {
    // RiC's ChildRelation is "oriented from the parent to the child".
    // Recording it the other way up would make the specialization a
    // lie, so this follows RiC and the editor fills the slots to suit.
    expect(editor.classInfo(PARENT_CHILD).types).toEqual([`${RICO}ChildRelation`]);
  });

  it('uses RiC\'s classes as they stand, coining nothing', () => {
    // Every kind is exactly one class somebody else maintains. A kind
    // RiC has no class for waits rather than being invented here.
    expect(editor.classInfo(SPOUSE).types).toEqual([`${RICO}SpouseRelation`]);
    expect(editor.classInfo(PARENT_CHILD).types).toEqual([`${RICO}ChildRelation`]);
    for (const classRuleId of PERSON_RELATIONSHIP_CLASSES) {
      for (const type of editor.classInfo(classRuleId).types) {
        expect(type.startsWith(RICO)).toBe(true);
      }
    }
  });

  it('declares the shape of each kind on the kind itself', () => {
    expect(editor.fields(SPOUSE).map((f) => f.name))
      .toEqual(['rico:relationConnects', 'rico:beginningDate', 'rico:endDate']);
    expect(editor.fields(PARENT_CHILD).map((f) => f.name))
      .toEqual(['rico:relationHasSource', 'rico:relationHasTarget', 'rico:beginningDate', 'rico:endDate']);
  });

  it('reads which fields hold people off the profile, not from a list here', () => {
    expect(participantFields(editor, SPOUSE)).toEqual(['rico:relationConnects']);
    expect(participantFields(editor, PARENT_CHILD)).toEqual(['rico:relationHasSource', 'rico:relationHasTarget']);
  });
});

describe('the kinds are disjoint', () => {
  const editor = rocphotosProfileEditor();

  it('checks every kind against every other', async () => {
    const crate = rootCrateWith('A', 'B');
    const written = [];
    for (const classRuleId of PERSON_RELATIONSHIP_CLASSES) {
      const values = participantFields(editor, classRuleId).length === 1
        ? { 'rico:relationConnects': [id('A'), id('B')] }
        : { 'rico:relationHasSource': id('A'), 'rico:relationHasTarget': id('B') };
      written.push({ classRuleId, ...writeRelationship(editor, crate, { classRuleId, values }) });
    }

    for (const { classRuleId, id: relationshipId } of written) {
      const matches = [];
      for (const candidate of PERSON_RELATIONSHIP_CLASSES) {
        if ((await editor.check(crate, relationshipId, candidate)).valid) matches.push(candidate);
      }
      expect(matches).toEqual([classRuleId]);
    }
  });
});

describe('writing a relationship', () => {
  const editor = rocphotosProfileEditor();

  it('mints an id that is not derived from who or what it joins', () => {
    // Two people can be related twice over, so nothing about the
    // participants or the kind can identify the relationship.
    expect(mintRelationshipId()).not.toEqual(mintRelationshipId());
    expect(mintRelationshipId()).toMatch(/^#relationship-[0-9a-f]{8}$/);
  });

  it('types the entity from the profile, compacted against the crate', async () => {
    const crate = rootCrateWith('Gail', 'Peter');
    const { id: relationshipId, created } = writeRelationship(editor, crate, {
      classRuleId: SPOUSE,
      values: { 'rico:relationConnects': [id('Gail'), id('Peter')], 'rico:beginningDate': '1972-03' },
    });

    expect(created).toBe(true);
    expect(crate.getEntity(relationshipId)['@type']).toEqual(['rico:SpouseRelation']);
    expect((await editor.check(crate, relationshipId, SPOUSE)).valid).toBe(true);
    // Not linked from the root dataset: it is found by its type.
    expect((crate.rootDataset.mentions ?? []).map((ref) => ref['@id'])).not.toContain(relationshipId);
  });

  it('changes the kind of an existing relationship rather than adding a second', async () => {
    const crate = rootCrateWith('Gail', 'Peter');
    const first = writeRelationship(editor, crate, {
      classRuleId: PARENT_CHILD,
      values: { 'rico:relationHasSource': id('Gail'), 'rico:relationHasTarget': id('Peter') },
    });

    const again = writeRelationship(editor, crate, {
      id: first.id,
      classRuleId: SPOUSE,
      values: { 'rico:relationConnects': [id('Gail'), id('Peter')], 'rico:endDate': '1999' },
    });

    expect(again).toEqual({ id: first.id, created: false });
    expect(crate.getEntity(first.id)['@type']).toEqual(['rico:SpouseRelation']);
    expect(await relationshipsFor(editor, crate, id('Gail'))).toHaveLength(1);
  });
});

describe('finding a person\'s relationships', () => {
  const editor = rocphotosProfileEditor();

  it('finds them whichever end of it they are, and names the kind once', async () => {
    const crate = rootCrateWith('Gail', 'Peter', 'Mabel');
    writeRelationship(editor, crate, {
      classRuleId: SPOUSE,
      values: { 'rico:relationConnects': [id('Gail'), id('Peter')] },
    });
    // Mabel is Peter's parent, so under RiC's direction she is the source.
    writeRelationship(editor, crate, {
      classRuleId: PARENT_CHILD,
      values: { 'rico:relationHasSource': id('Mabel'), 'rico:relationHasTarget': id('Peter') },
    });

    expect((await relationshipsFor(editor, crate, id('Peter'))).map((r) => r.classRuleId))
      .toEqual([SPOUSE, PARENT_CHILD]);
    expect((await relationshipsFor(editor, crate, id('Mabel'))).map((r) => r.classRuleId)).toEqual([PARENT_CHILD]);
    expect(await relationshipsFor(editor, crate, id('Nobody'))).toEqual([]);
  });

  it('removes the statement without touching the people it was about', async () => {
    const crate = rootCrateWith('Gail', 'Peter');
    const { id: relationshipId } = writeRelationship(editor, crate, {
      classRuleId: SPOUSE,
      values: { 'rico:relationConnects': [id('Gail'), id('Peter')] },
    });

    expect(deleteRelationship(crate, relationshipId)).toBe(true);

    expect(crate.getEntity(relationshipId)).toBeUndefined();
    expect((crate.rootDataset.mentions ?? []).map((ref) => ref['@id'])).not.toContain(relationshipId);
    expect(crate.getEntity(id('Gail'))).toBeTruthy();
    expect(crate.getEntity(id('Peter'))).toBeTruthy();
    expect(deleteRelationship(crate, '#relationship-nothere')).toBe(false);
  });
});

describe('what a form is told to call each field', () => {
  const editor = rocphotosProfileEditor();

  it('takes the words from the class, not from the property name', () => {
    // relationHasSource/relationHasTarget are the same pair for every
    // directed kind, so the property name cannot say what either end
    // means. A rule declared per class can, and these do.
    const labels = (classRuleId) => editor.fields(classRuleId).map((f) => f.label);
    expect(labels(PARENT_CHILD)).toEqual(['Parent', 'Child', 'Began', 'Ended']);
    expect(labels(SPOUSE)).toEqual(['Spouses', 'Began', 'Ended']);
  });

  it('explains each end in its own terms, not by deferring to the class', () => {
    const help = (classRuleId, label) => editor.fields(classRuleId).find((f) => f.label === label).help;
    expect(help(PARENT_CHILD, 'Parent')).toMatch(/^The parent\./);
    expect(help(PARENT_CHILD, 'Child')).toMatch(/^The child/);
    expect(help(SPOUSE, 'Spouses')).toMatch(/Neither comes first/);
    for (const classRuleId of PERSON_RELATIONSHIP_CLASSES) {
      for (const field of editor.fields(classRuleId)) {
        expect(field.help).not.toMatch(/depends on the kind/);
      }
    }
  });

  it('puts a class\'s own fields before the ones it shares', () => {
    // The specific before the general: a relationship is about the
    // people in it, and the dates every kind shares come after them.
    for (const classRuleId of PERSON_RELATIONSHIP_CLASSES) {
      const names = editor.fields(classRuleId).map((f) => f.name);
      const lastParticipant = Math.max(...participantFields(editor, classRuleId).map((n) => names.indexOf(n)));
      expect(lastParticipant).toBeLessThan(names.indexOf('rico:beginningDate'));
    }
  });
});

describe('a person can be at either end', () => {
  const editor = rocphotosProfileEditor();

  it('notices that two slots take the same kind of thing, and says they can be exchanged', () => {
    // Worked out from the profile: both ends of a parent-child
    // relationship have Person as their range, so either could hold
    // either person and only somebody looking at it knows which way
    // round is right.
    expect(swappableParticipants(editor, PARENT_CHILD))
      .toEqual(['rico:relationHasSource', 'rico:relationHasTarget']);
  });

  it('offers nothing to exchange where there are not two such slots', () => {
    // A marriage has one repeatable field, not two slots.
    expect(swappableParticipants(editor, SPOUSE)).toBeNull();
  });

  it('finds the same relationship from whichever end the person is', async () => {
    const crate = rootCrateWith('Mabel', 'Peter');
    const { id: relationshipId } = writeRelationship(editor, crate, {
      classRuleId: PARENT_CHILD,
      values: { 'rico:relationHasSource': id('Mabel'), 'rico:relationHasTarget': id('Peter') },
    });

    for (const who of ['Mabel', 'Peter']) {
      const found = await relationshipsFor(editor, crate, id(who));
      expect(found.map((r) => r.id)).toEqual([relationshipId]);
    }
  });

  it('is the same relationship after its ends are exchanged, not a second one', async () => {
    const crate = rootCrateWith('Mabel', 'Peter');
    const { id: relationshipId } = writeRelationship(editor, crate, {
      classRuleId: PARENT_CHILD,
      values: { 'rico:relationHasSource': id('Mabel'), 'rico:relationHasTarget': id('Peter') },
    });

    // What the form's swap amounts to: the two values change places
    // and the relationship is saved under its own id.
    writeRelationship(editor, crate, {
      id: relationshipId,
      classRuleId: PARENT_CHILD,
      values: { 'rico:relationHasSource': id('Peter'), 'rico:relationHasTarget': id('Mabel') },
    });

    expect(await relationshipsFor(editor, crate, id('Mabel'))).toHaveLength(1);
    expect(crate.getEntity(relationshipId)['rico:relationHasSource'][0]['@id']).toEqual(id('Peter'));
    expect((await editor.check(crate, relationshipId, PARENT_CHILD)).valid).toBe(true);
  });
});
