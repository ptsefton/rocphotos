import { MAIN_PERSON_CLASS, PERSON_RELATIONSHIP_CLASSES } from '../../masp/rocphotosProfile.js';
import { compactIri } from '../crateBuilder.js';

/**
 * Relationships between people, as entities in the root crate.
 *
 * A relationship is not a property of either person — a marriage is
 * not something one of them has — so it is a node of its own joining
 * them, which is also what lets it carry a kind and a span of time. The
 * profile specializes RiC's `rico:Relation` for this, in two flavours:
 * one undirected (`relationConnects` lists the people, in no
 * significant order) and one directed (`relationHasSource` to
 * `relationHasTarget`).
 *
 * Nothing here names a field. Which fields hold people is read off the
 * profile — they are the ones whose range is the person class — so a
 * relationship class gaining a participant, or a third class being
 * added, needs no change in this file.
 *
 * They live in the root crate because that is where people are
 * described (see crateBuilder's syncRootCrateSubjects); a
 * sub-collection crate holds only names.
 */

/**
 * A fresh relationship id.
 *
 * Random, not derived from the people or the kind: two people can be
 * related twice over, the same way an id is minted once and frozen
 * rather than recomputed from a name (see core/subjects.js). A crate
 * fragment rather than an `arcp://` identity because a relationship is
 * only ever referenced from the crate that holds it.
 */
export function mintRelationshipId() {
  // globalThis.crypto, not node:crypto: this same module is bundled
  // into the Service Worker, which has the web one and not the other.
  return `#relationship-${crypto.randomUUID().slice(0, 8)}`;
}

/** The fields of a relationship class that name a person. */
export function participantFields(editor, classRuleId) {
  return editor.fields(classRuleId)
    .filter((field) => field.referenceClasses.includes(MAIN_PERSON_CLASS))
    .map((field) => field.name);
}

/**
 * The two slots of a relationship that hold the same kind of thing,
 * and so can be exchanged — or null where the class has no such pair.
 *
 * Worked out from the profile rather than listed here: a participant
 * field is one whose range is a class, and two single-valued ones
 * whose ranges overlap are slots either of which could hold the same
 * entity. For a parent-child relationship that is the parent and the
 * child, both of which take a Person, which is exactly why somebody
 * looking at one of them needs to be able to say "no, the other way
 * round" — the profile cannot know which of two people is the parent.
 *
 * An undirected kind has one repeatable field rather than two slots,
 * so there is nothing to exchange and this returns null.
 *
 * @returns {[string, string]|null}
 */
export function swappableParticipants(editor, classRuleId) {
  const slots = editor.fields(classRuleId)
    .filter((field) => field.referenceClasses.length > 0 && !field.multiple);
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      const sameRange = slots[i].referenceClasses.some((cls) => slots[j].referenceClasses.includes(cls));
      if (sameRange) return [slots[i].name, slots[j].name];
    }
  }
  return null;
}

/**
 * Every relationship in the crate that this person is part of.
 *
 * @param {object} editor - the profile editor
 * @param {import('ro-crate').ROCrate} crate - the root crate
 * @param {string} personId
 * @returns {Promise<Array<{id: string, classRuleId: string, values: object, check: object}>>}
 */
export async function relationshipsFor(editor, crate, personId) {
  const found = [];
  const classified = new Set();
  for (const classRuleId of PERSON_RELATIONSHIP_CLASSES) {
    const fields = participantFields(editor, classRuleId);
    for (const id of await editor.instancesOf(crate, classRuleId)) {
      // One kind each. The kinds are disjoint by their types, so this
      // guards against a crate that carries more of them than it
      // should rather than against the ordinary case — and it means
      // the editor shows a relationship once, under the first kind in
      // PERSON_RELATIONSHIP_CLASSES that it satisfies.
      if (classified.has(id)) continue;
      const values = editor.read(crate, id, classRuleId);
      const joinsThisPerson = fields.some((field) => (values[field] ?? []).some((value) => value?.['@id'] === personId));
      if (!joinsThisPerson) continue;
      classified.add(id);
      found.push({ id, classRuleId, values, check: await editor.check(crate, id, classRuleId) });
    }
  }
  return found;
}

/**
 * Creates or updates a relationship in the crate.
 *
 * A new one is typed `rico:Relation`. It is not linked from the root
 * dataset; the people it joins are what it points at. Everything else
 * — including copying each chosen term's definition into the crate,
 * which MASP requires — is the profile editor's `write`.
 *
 * @returns {{id: string, created: boolean}}
 */
export function writeRelationship(editor, crate, { id = null, classRuleId, values }) {
  const relationshipId = id ?? mintRelationshipId();
  const created = !crate.getEntity(relationshipId);
  // The types come from the profile, not from here: the kind of a
  // relationship is its class, and which vocabulary that class came
  // from — RiC's own, or a term coined beside it — is the profile's
  // business. Compacted against the crate's context so the crate
  // reads `rico:ChildRelation` rather than a bare IRI.
  const types = editor.classInfo(classRuleId).types.map((iri) => compactIri(crate, iri));
  if (created) crate.addEntity({ '@id': relationshipId, '@type': types });
  else crate.getEntity(relationshipId)['@type'] = types;
  editor.write(crate, relationshipId, values, classRuleId);
  return { id: relationshipId, created };
}

/**
 * Removes a relationship.
 *
 * The people it joined are left alone, for the same reason removing an
 * image never deletes the Person it depicted: they exist independently
 * of this statement about them.
 */
export function deleteRelationship(crate, id) {
  if (!crate.getEntity(id)) return false;
  // Only an older crate still lists it here (see the
  // remove-root-mentions migration).
  crate.deleteValues(crate.rootId, 'mentions', { '@id': id });
  crate.deleteEntity(id);
  return true;
}
