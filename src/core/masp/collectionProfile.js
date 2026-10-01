import { ROCPHOTOS_DIR_NAME } from '../trash.js';
import { joinPath } from '../pathUtils.js';
import { createProfileEditor } from '../../masp/profileEditor.js';
import {
  rocphotosProfileEditor, MAIN_PERSON_CLASS, PERSON_RELATIONSHIP_CLASSES, PROFILE_OVERRIDES,
} from '../../masp/rocphotosProfile.js';

/**
 * A MASP profile a collection carries of its own, overriding the one
 * built into this version of the app.
 *
 * The built-in profile is vendored (see vendor/masp/README.md) and so
 * is fixed for everybody running a given build. That is the right
 * default — it is what stops an experiment upstream changing what this
 * app accepts without anyone noticing — but it leaves no way for
 * somebody to try a change to the profile and see what it does. This
 * is that way: drop a profile crate into the collection and the editor
 * is built from it instead.
 *
 * It lives in the collection rather than in the app because that is
 * what makes it portable and what makes it per-collection: handing
 * somebody the folder hands them the profile their metadata was
 * written against, and two collections on one machine can be trying
 * different things.
 */

export const COLLECTION_PROFILE_PATH = joinPath(ROCPHOTOS_DIR_NAME, 'masp', 'profile.json');

// Rebuilding an editor means parsing a 50KB crate and every rule in
// it, which happens on each request that touches a person. Keyed by
// the file's own text, so a profile installed while the app is running
// takes effect on the next request and an unchanged one costs nothing.
let cached = { text: null, editor: null };

function editorForText(text) {
  if (text === null) return rocphotosProfileEditor();
  if (cached.text === text) return cached.editor;
  const editor = createProfileEditor({ profile: JSON.parse(text), overrides: PROFILE_OVERRIDES });
  cached = { text, editor };
  return editor;
}

/** The installed profile's text, or null where a collection has none. */
export async function loadCollectionProfileText(fsAdapter) {
  if (!(await fsAdapter.exists(COLLECTION_PROFILE_PATH))) return null;
  return new TextDecoder().decode(await fsAdapter.readFile(COLLECTION_PROFILE_PATH));
}

/**
 * The profile editor this collection should be edited through: its own
 * profile where it has one, and the built-in profile otherwise.
 *
 * A collection profile that will not parse or will not build is
 * ignored rather than allowed to break the People tab — it was checked
 * when it was installed, so reaching this means somebody edited the
 * file by hand, and falling back leaves them with a working editor to
 * fix it from.
 *
 * @param {import('../fsAdapter.js').FsAdapter} fsAdapter
 */
export async function collectionProfileEditor(fsAdapter) {
  try {
    return editorForText(await loadCollectionProfileText(fsAdapter));
  } catch {
    return rocphotosProfileEditor();
  }
}

/**
 * What a profile has to provide before this app will install it.
 *
 * Only what the app genuinely cannot work without: a person class it
 * can address by the id the app uses, carrying a `name`, since a
 * person's identity here is derived from their name. Everything else
 * is the profile's business — a profile that declares no relationship
 * classes simply gets no Relationships section, which is a tweak
 * somebody might well be trying.
 *
 * @returns {string[]} what is wrong with it, empty if nothing is
 */
export function profileProblems(profileJson) {
  const editor = createProfileEditor({ profile: profileJson, overrides: PROFILE_OVERRIDES });
  const problems = [];

  let personFields = null;
  try {
    editor.classInfo(MAIN_PERSON_CLASS);
    personFields = editor.fields(MAIN_PERSON_CLASS);
  } catch {
    problems.push(`This profile declares no ${MAIN_PERSON_CLASS}. rocphotos edits people through that class, and addresses it by that id.`);
  }

  if (personFields && !personFields.some((field) => field.name === 'name')) {
    problems.push(`${MAIN_PERSON_CLASS} declares no "name" property. A person's identity in rocphotos is derived from their name, so one is required.`);
  }

  return problems;
}

/**
 * Installs a profile for this collection, or refuses it and says why.
 *
 * @returns {Promise<{installed: boolean, problems: string[]}>}
 */
export async function installCollectionProfile(fsAdapter, text) {
  let profileJson;
  try {
    profileJson = JSON.parse(text);
  } catch (err) {
    return { installed: false, problems: [`That file is not JSON: ${err.message}`] };
  }

  let problems;
  try {
    problems = profileProblems(profileJson);
  } catch (err) {
    // A crate MASP cannot parse at all — no schema-role descriptor, a
    // broken context, something of that kind.
    return { installed: false, problems: [`That file is not a profile this app can read: ${err.message}`] };
  }
  if (problems.length > 0) return { installed: false, problems };

  await fsAdapter.writeFile(COLLECTION_PROFILE_PATH, text);
  cached = { text: null, editor: null };
  return { installed: true, problems: [] };
}

/** Goes back to the profile built into this version of the app. */
export async function removeCollectionProfile(fsAdapter) {
  if (!(await fsAdapter.exists(COLLECTION_PROFILE_PATH))) return false;
  await fsAdapter.deleteFile(COLLECTION_PROFILE_PATH);
  cached = { text: null, editor: null };
  return true;
}

/**
 * The relationship classes an editor actually declares.
 *
 * An uploaded profile need not describe all of them, or any — the
 * point of letting somebody try a change is that the result may be a
 * smaller profile than the one shipped. Anything it does not declare
 * is simply not offered.
 */
export function availableRelationshipClasses(editor) {
  return PERSON_RELATIONSHIP_CLASSES.filter((classRuleId) => {
    try {
      editor.classInfo(classRuleId);
      return true;
    } catch {
      return false;
    }
  });
}

/** What the Settings screen shows about whichever profile is in use. */
export async function describeActiveProfile(fsAdapter) {
  const text = await loadCollectionProfileText(fsAdapter).catch(() => null);
  const editor = await collectionProfileEditor(fsAdapter);
  const usingCollection = text !== null && editor !== rocphotosProfileEditor();
  return {
    source: usingCollection ? 'collection' : 'built-in',
    path: usingCollection ? COLLECTION_PROFILE_PATH : 'vendor/masp/rocphotos-profile.json',
    person: (() => {
      try {
        return editor.classInfo(MAIN_PERSON_CLASS);
      } catch {
        return null;
      }
    })(),
    relationshipClasses: availableRelationshipClasses(editor).map((id) => editor.classInfo(id)),
  };
}
