import { personEntityId, petEntityId, ENTITY_TYPE_PERSON, ENTITY_TYPE_PET } from './db/store.js';

/**
 * Deciding which Person/Pet a name refers to.
 *
 * An id used to be a pure function of the name (`personEntityId`), so
 * no decision was needed: the same name computed the same id anywhere,
 * and renaming somebody therefore moved them to a different id and
 * dragged every reference in the collection along behind it. A name is
 * a label and an id is an identity; conflating them meant correcting a
 * spelling rewrote thousands of files.
 *
 * So an id is now minted once, from the name the person was first seen
 * under, and never recomputed. Renaming changes the label and leaves
 * the id alone. Everything that has to go the other way — a photo file
 * says "Gail McGlinn" and we need to know who that is — resolves the
 * name through here instead of computing it.
 *
 * ## Where the answer comes from
 *
 * In order, because each is more reliable than the next:
 *
 * 1. **The crate being written.** Every crate carries a copy of each
 *    identity it depicts, with its name, so a rescan of a crate that
 *    already knows this person needs nothing else — and a crate stays
 *    self-describing even if the index is thrown away.
 * 2. **The collection,** via a lookup the caller supplies (the index,
 *    or the root crate). This is what links a person across crates.
 * 3. **A freshly minted id,** seeded from the name. Only reached for
 *    somebody nothing has seen before.
 *
 * Step 3 producing the same id the old code computed is what makes
 * this cost no migration: existing ids stay exactly as they are and
 * simply stop being recalculated.
 */

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstString(value) {
  for (const item of asArray(value)) {
    if (typeof item === 'string') return item;
  }
  return undefined;
}

/** The id this type of subject would be minted under, from a name. */
export function mintSubjectId(name, subjectType) {
  return subjectType === 'Pet' ? petEntityId(name) : personEntityId(name);
}

/**
 * The id a crate already uses for a subject of this name, or null.
 *
 * Matched on the entity's own `name`, not on what its id looks like:
 * after a rename the two no longer agree, and the whole point is that
 * the id has stopped being readable as the name.
 *
 * @param {import('ro-crate').ROCrate} crate
 * @param {string} name
 * @param {'Person'|'Pet'} subjectType
 * @returns {string|null}
 */
export function subjectIdInCrate(crate, name, subjectType) {
  for (const entity of crate.entities()) {
    if (!asArray(entity['@type']).includes(subjectType)) continue;
    // A per-crate instance or a region body proxy is not an identity of
    // its own (see crateBuilder's addSubjectIdentity); it specializes
    // one, and it is the one it specializes that should be referenced.
    if (entity['prov:specializationOf']) continue;
    if (firstString(entity.name) === name) return entity['@id'];
  }
  return null;
}

/**
 * The id to use for a subject of this name, resolved and then minted
 * as a last resort — see this module's own notes for the order.
 *
 * @param {string} name
 * @param {'Person'|'Pet'} subjectType
 * @param {object} [sources]
 * @param {import('ro-crate').ROCrate} [sources.crate] - the crate being written
 * @param {(name: string, subjectType: 'Person'|'Pet') => string|null} [sources.lookup] - the collection-wide registry
 * @returns {string}
 */
export function resolveSubjectId(name, subjectType, { crate = null, lookup = null } = {}) {
  if (crate) {
    const inCrate = subjectIdInCrate(crate, name, subjectType);
    if (inCrate) return inCrate;
  }
  if (lookup) {
    const known = lookup(name, subjectType);
    if (known) return known;
  }
  return mintSubjectId(name, subjectType);
}

/**
 * A collection-wide lookup backed by the SQLite index, which holds a
 * row per identity with both its id and its current name.
 *
 * Built once per scan rather than queried per region: a scan asks this
 * for every tagged face in every photo, and the whole table is a few
 * hundred rows.
 *
 * @param {import('../adapters/nodeSqlite.js').SqliteDriver} db
 * @returns {(name: string, subjectType: 'Person'|'Pet') => string|null}
 */
export function subjectLookupFromIndex(db) {
  const byName = new Map();
  for (const row of db.all(
    'SELECT id, name, entity_type FROM entities WHERE entity_type IN (?, ?)',
    [ENTITY_TYPE_PERSON, ENTITY_TYPE_PET],
  )) {
    if (row.name) byName.set(`${row.entity_type}\u0000${row.name}`, row.id);
  }
  const typeIri = (subjectType) => (subjectType === 'Pet' ? ENTITY_TYPE_PET : ENTITY_TYPE_PERSON);
  return (name, subjectType) => byName.get(`${typeIri(subjectType)}\u0000${name}`) ?? null;
}

/**
 * One name resolved against the index, or minted — the single-row form
 * of subjectLookupFromIndex, for a caller that asks about one person at
 * a time rather than sweeping a collection.
 *
 * @param {import('../adapters/nodeSqlite.js').SqliteDriver} db
 * @param {string} name
 * @param {'Person'|'Pet'} subjectType
 * @returns {string}
 */
export function resolveSubjectIdFromIndex(db, name, subjectType = 'Person') {
  const row = db.get(
    'SELECT id FROM entities WHERE entity_type = ? AND name = ?',
    [subjectType === 'Pet' ? ENTITY_TYPE_PET : ENTITY_TYPE_PERSON, name],
  );
  return row?.id ?? mintSubjectId(name, subjectType);
}

/**
 * A lookup backed by a crate — the root crate, which is where identities
 * are described and so the authority the index is only a cache of.
 *
 * @param {import('ro-crate').ROCrate} crate
 * @returns {(name: string, subjectType: 'Person'|'Pet') => string|null}
 */
export function subjectLookupFromCrate(crate) {
  return (name, subjectType) => subjectIdInCrate(crate, name, subjectType);
}
