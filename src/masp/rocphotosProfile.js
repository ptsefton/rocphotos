import { createProfileEditor } from './profileEditor.js';
import profileJson from '../../vendor/masp/rocphotos-profile.json' with { type: 'json' };

/**
 * rocphotos' own binding of the generic profile editor to the rocphotos
 * MASP profile — the only module in src/masp/ that knows which profile
 * this application uses or which of its classes are editable.
 *
 * The profile comes from vendor/masp/, a pinned copy rather than the
 * MASP checkout next door (see vendor/masp/README.md): editing the
 * profile over there changes what rocphotos offers and accepts only
 * after `npm run sync:masp`, where it shows up as a reviewable diff.
 */

/**
 * The class rule for a person's collection-wide identity — the node in
 * the root crate that carries everything known about them.
 *
 * Addressed by rule id, not by type: the profile has a second rule for
 * `schema:Person`, `#InstancePersonClass`, covering the per-crate
 * instance that images and face regions actually point at, and the two
 * are distinguished only by which properties each requires.
 */
export const MAIN_PERSON_CLASS = '#MainPersonClass';

/**
 * The kinds of relationship between two people, in the order the
 * editor offers them.
 *
 * Each kind is a class, not a term chosen on a shared class, because a
 * `DefinedTerm` cannot say which end of a relation plays which role. A
 * class can, and these do: `#ParentChildRelationshipClass` carries
 * RiC's own definition, under which the parent is the source.
 *
 * Only the two kinds RiC already has a class for. Nothing is coined
 * here: a kind RiC does not cover waits until there is a way to say it
 * in a vocabulary somebody else maintains.
 *
 * Which of their fields name the people involved is not listed here —
 * it is read off the profile, as the fields whose range is the person
 * class, so a kind gaining a participant needs no change here.
 */
export const PARENT_CHILD_RELATIONSHIP_CLASS = '#ParentChildRelationshipClass';

export const PERSON_RELATIONSHIP_CLASSES = [
  '#SpouseRelationshipClass',
  PARENT_CHILD_RELATIONSHIP_CLASS,
];

// The two things the profile has no way to say (see createProfileEditor's
// own notes on overrides): that a description is prose rather than a
// line, and that rocphotos can hold only one name per person, because a
// person's entity id is derived from their name (db/store.js's
// personEntityId) and a second name is therefore a second person. The
// second is a limit of this application, not of the profile, so it only
// stops the form offering a name to add — people/handler.js refuses a
// second name on its own, where it can explain why.
export const PROFILE_OVERRIDES = {
  '#prop_person_description': { widget: 'textarea' },
  '#prop_person_name': { multiple: false },
};

let editor = null;

/**
 * The shared editor for this collection's profile. Built once: parsing
 * the profile's rules is the expensive part, and the result depends on
 * nothing but the vendored file, so there is nothing to invalidate.
 *
 * @returns {ReturnType<typeof createProfileEditor>}
 */
export function rocphotosProfileEditor() {
  if (!editor) editor = createProfileEditor({ profile: profileJson, overrides: PROFILE_OVERRIDES });
  return editor;
}
