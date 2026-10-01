import {
  getEntityById,
  deleteEntityById,
  searchEntities,
  countSearchResults,
  facetCounts,
  personEntityId,
  crateEntityId,
  listDepictedSubjects,
  crateDirPathFromEntityId,
  crateRelativeEntityId,
  ENTITY_TYPE_IMAGE,
  upsertEntity,
} from '../db/store.js';
import {
  CRATE_FILE_NAME, loadOrCreateCrate, serializeCrate, readImageRecord,
  renamePersonInCrate, renameSubjectInCrate, subjectInstanceId, syncRootCrateSubjects, foldSubjectInto,
} from '../crateBuilder.js';
import { resolveSubjectId, subjectIdInCrate } from '../subjects.js';
import { syncImageIndexFromCrate } from '../scanImage.js';
import { joinPath } from '../pathUtils.js';
import { serializeWrites } from '../writeQueue.js';
import { mergePersonInFacesStore, renamePersonInFacesStore } from '../faces/store.js';
import { loadOrCreateFacesCrate, saveFacesCrate } from '../faces/crate.js';
import { MAIN_PERSON_CLASS } from '../../masp/rocphotosProfile.js';
import { collectionProfileEditor, availableRelationshipClasses } from '../masp/collectionProfile.js';
import { relationshipsFor, writeRelationship, deleteRelationship, participantFields, swappableParticipants } from './relationships.js';

function json(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function badRequest(message) {
  return json(400, { error: message });
}

async function persistStore(store) {
  await store.persist?.();
}

// A page of image ids at a time, not the whole collection in one array —
// mirrors the general searchEntities/countSearchResults pagination
// discipline this app already has to apply everywhere else (see
// webview/app.js's fetchKnownPeople): a name depicted in more than the
// default limit's worth of photos must never have some of them silently
// left un-merged.
const MERGE_PAGE_SIZE = 200;

/**
 * Creates a pure, transport-agnostic handler for the `/people/*` routes
 * (mounted at `/api/people/*` — see bin/rocphotos.js's `serve` and
 * src/sw.js) backing the web view's People tab (see Spec.md's People
 * section): listing every distinct Person, and re-pointing one or more
 * of them at a single surviving identity.
 *
 * Renaming and merging are the same operation here, not two, because a
 * Person's identity is 100% name-derived (see db/store.js's
 * personEntityId): giving one person a new name and folding several
 * people into one both come down to "every one of these names now means
 * this name instead". One source name is a rename, several is a merge,
 * and a rename whose new name happens to be one already in use is
 * simply a merge into it — which is why this route takes a list and
 * does not try to tell the cases apart. The web view labels its button
 * for whichever is happening, since to a person using it they are
 * obviously different things.
 *
 * It never touches an original photo file — only crate JSON-LD and the
 * two SQLite indexes — so, unlike the faces handler's /confirm, it
 * needs no writeFaceRegion/writeBackEnabled capability and behaves
 * identically in every run mode.
 *
 * @param {object} deps
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver & {persist?: () => Promise<void>}} deps.mainStore - the main photo index
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver & {persist?: () => Promise<void>}} deps.facesStore - the faces companion index (_rocphotos/faces/faces-index.sqlite)
 * @param {import('../fsAdapter.js').FsAdapter} deps.fsAdapter
 * @param {Map<string, import('ro-crate').ROCrate>} [deps.crateCache] - the AROCAPI handler's own long-lived read cache, shared here the same way faces/handler.js's /confirm shares it, so a merge is reflected immediately in GET /entity/{id}/metadata rather than only after the crate is next evicted/reloaded.
 */
export function createPeopleHandler({ mainStore, facesStore, fsAdapter, crateCache = null }) {
  async function loadCrateForEdit(cache, roCrateId) {
    if (!cache.has(roCrateId)) {
      const cratePath = joinPath(crateDirPathFromEntityId(roCrateId), CRATE_FILE_NAME);
      const json = (await fsAdapter.exists(cratePath)) ? new TextDecoder().decode(await fsAdapter.readFile(cratePath)) : null;
      cache.set(roCrateId, loadOrCreateCrate(json));
    }
    return cache.get(roCrateId);
  }

  async function saveEditedCrates(cache) {
    for (const [roCrateId, crate] of cache) {
      await fsAdapter.writeFile(joinPath(crateDirPathFromEntityId(roCrateId), CRATE_FILE_NAME), serializeCrate(crate));
      crateCache?.set(roCrateId, crate);
    }
  }

  /**
   * Re-points every reference to each of `sourceNames` at `targetName`,
   * across every crate that depicts them and across both SQLite indexes.
   *
   * Extracted from the /merge route because editing a person's canonical
   * record is the same operation whenever their name is one of the
   * things edited: a person's identity is derived entirely from their
   * name (see this handler's own doc comment), so changing the name on
   * the form is a rename of exactly this kind, not a field update.
   *
   * The caller runs this inside serializeWrites and passes
   * `editRootCrate` to make its own changes to the root crate in the
   * same read-modify-write — anything written there afterwards would be
   * overwritten by the save at the end of this function, and anything
   * written before would be discarded by syncRootCrateSubjects, which
   * replaces a renamed-away identity with a fresh node.
   *
   * @param {object} options
   * @param {string[]} options.sourceNames
   * @param {string} options.targetName
   * @param {(rootCrate: import('ro-crate').ROCrate) => void|Promise<void>} [options.editRootCrate]
   * @returns {Promise<{targetId: string, imagesUpdated: number, unreadable: string[]}>} - `unreadable` lists images the index holds but their crate does not
   */
  async function mergeNames({ sourceNames, targetName, editRootCrate = null }) {
    // Resolved against the root crate, never computed: an identity is
    // minted once and frozen (see subjects.js), so a person whose
    // spelling was corrected has an id that no longer matches their
    // name, and computing one here would merge into a stranger.
    const registry = await loadCrateForEdit(new Map(), crateEntityId(''));
    const idFor = (name) => resolveSubjectId(name, 'Person', { crate: registry });
    const targetId = idFor(targetName);
    const sourceIds = sourceNames.map(idFor);

    const cache = new Map();
    const touchedImageIds = new Set();

    for (let i = 0; i < sourceNames.length; i++) {
      const sourceName = sourceNames[i];
      const sourceId = sourceIds[i];
      if (sourceId === targetId) continue; // this source's name is already exactly targetName

      const filters = { people: sourceName, entityType: ENTITY_TYPE_IMAGE };
      const total = countSearchResults(mainStore, filters);
      for (let offset = 0; offset < total; offset += MERGE_PAGE_SIZE) {
        const rows = searchEntities(mainStore, filters, { limit: MERGE_PAGE_SIZE, offset });
        for (const row of rows) {
          const crate = await loadCrateForEdit(cache, row.ro_crate_id);
          const imagePath = crateRelativeEntityId(row.ro_crate_id, row.id);
          renamePersonInCrate(crate, imagePath, { sourceId, sourceName, targetId, targetName, subjectType: 'Person' });
          touchedImageIds.add(row.id);
        }
      }

      // Every crate that could possibly still hold sourceId's own
      // Person node is now in `cache` — every image that referenced
      // it was just found via the paginated search above, and
      // renamePersonInCrate itself never removes that node (see its
      // own doc comment: it is this caller's job, once, only after
      // every image that still needed it has been re-pointed).
      // Removing it now, rather than leaving it in the crate
      // forever, is what keeps a merge from leaving a dangling,
      // unreferenced Person node behind.
      const sourceInstanceId = subjectInstanceId(sourceName, 'Person');
      for (const crate of cache.values()) {
        if (crate.getEntity(sourceId)) crate.deleteEntity(sourceId);
        // Its crate-local instance goes too (see addSubjectInstance):
        // every image that pointed at it now points at the target's.
        if (crate.getEntity(sourceInstanceId)) crate.deleteEntity(sourceInstanceId);
      }
    }

    // Re-derives every touched image's people/pets (and other)
    // facet rows straight from its now-rewritten crate record —
    // the same read-modify-write shape /faces/confirm already
    // uses — rather than hand-patching entity_facets rows here,
    // so this can never drift from what the crate itself now says.
    // Also upserts the target Person's own entities row (see
    // syncImageIndexFromCrate), so it exists even if this is a
    // brand new name no image was ever tagged with before.
    const unreadable = [];
    for (const imageId of touchedImageIds) {
      const row = getEntityById(mainStore, imageId);
      const crate = cache.get(row.ro_crate_id);
      const crateDirPath = crateDirPathFromEntityId(row.ro_crate_id);
      const imagePath = crateRelativeEntityId(row.ro_crate_id, imageId);
      const record = readImageRecord(crate, imagePath);
      // An image the index lists but its crate does not hold — the
      // directory was deleted outside the app, say, and nothing has
      // rescanned since. Reported rather than thrown: one stale row
      // should not stop a rename the rest of the collection can take,
      // and the alternative was an opaque 500 from deep inside the
      // index sync.
      if (!record) {
        unreadable.push(imageId);
        continue;
      }
      syncImageIndexFromCrate(mainStore, crateDirPath, imagePath, record);
    }

    // The root crate names every identity in the collection (see
    // syncRootCrateSubjects) — after a merge that set has changed,
    // and nothing else would notice until the next scan. Done after
    // the index is re-derived above, so it reads the new truth.
    const rootCrateId = crateEntityId('');
    const rootCrate = await loadCrateForEdit(cache, rootCrateId);
    syncRootCrateSubjects(rootCrate, listDepictedSubjects(mainStore));
    // A merged-away name is superseded, not merely untagged, so it goes
    // even though syncRootCrateSubjects now leaves an identity alone
    // once anything has been written about them — and what it knew
    // moves to the survivor rather than going with it.
    for (const sourceId of sourceIds) {
      foldSubjectInto(rootCrate, { sourceId, targetId });
    }
    // After the fold, so a value typed into the editor wins over one
    // inherited from the spelling it replaced.
    if (editRootCrate) await editRootCrate(rootCrate);

    await saveEditedCrates(cache);
    await persistStore(mainStore);

    // Every merged-away name's own entities row is now orphaned —
    // nothing in entity_facets points to it any more, since every
    // image that referenced it was just re-derived above — so it is
    // removed outright rather than left as a dead row.
    const mergedAwayIds = sourceIds.filter((id) => id !== targetId);
    for (const sourceId of mergedAwayIds) {
      deleteEntityById(mainStore, sourceId);
    }

    // The separate faces-recognition index (faces/store.js) keeps
    // its own redundant copies of person id/name for matching and
    // review-screen suggestions — all of them need to point at the
    // surviving identity too, or a later "Recognize Faces" run, or a
    // rejected-suggestion re-match, would silently forget this merge.
    const { movedReferenceFaceIds } = mergePersonInFacesStore(facesStore, { sourceIds: mergedAwayIds, targetId, targetName });
    await persistStore(facesStore);

    if (movedReferenceFaceIds.length > 0) {
      // Purely-for-inspection mirror of reference_faces (see
      // faces/crate.js) — matching itself never reads this file, but
      // it should not go on showing a merged-away name forever.
      const facesCrate = await loadOrCreateFacesCrate(fsAdapter);
      for (const id of movedReferenceFaceIds) {
        const entity = facesCrate.getEntity(id);
        if (!entity) continue;
        entity.about = { '@id': targetId };
        entity.name = targetName;
      }
      await saveFacesCrate(fsAdapter, facesCrate);
    }

    return { targetId, imagesUpdated: touchedImageIds.size - unreadable.length, unreadable };
  }

  /**
   * Changes what the collection calls somebody, without moving them.
   *
   * The counterpart to mergeNames, and now a genuinely different
   * operation: an id is minted once and frozen (see subjects.js), so a
   * rename touches no reference anywhere. It rewrites the identity's
   * own `name` in each crate that holds a copy, the display name each
   * region duplicates, the index's row and facet values, and the four
   * places the faces index keeps a name beside an id. Nothing is
   * deleted and nothing is re-pointed.
   *
   * Run inside serializeWrites by the caller, like mergeNames.
   *
   * @param {{subjectId: string, oldName: string, newName: string}} options
   * @returns {Promise<{imagesUpdated: number, unreadable: string[]}>}
   */
  async function renameSubject({ subjectId, oldName, newName }) {
    const cache = new Map();
    const touchedImageIds = new Set();

    const filters = { people: oldName, entityType: ENTITY_TYPE_IMAGE };
    const total = countSearchResults(mainStore, filters);
    for (let offset = 0; offset < total; offset += MERGE_PAGE_SIZE) {
      for (const row of searchEntities(mainStore, filters, { limit: MERGE_PAGE_SIZE, offset })) {
        const crate = await loadCrateForEdit(cache, row.ro_crate_id);
        renameSubjectInCrate(crate, { subjectId, newName });
        // Added whether or not that changed anything, the same way
        // mergeNames does: every image depicting this person carries
        // their name, so one that did not change is one whose crate
        // could not be read, and the loop below is what notices.
        touchedImageIds.add(row.id);
      }
    }

    const unreadable = [];
    for (const imageId of touchedImageIds) {
      const row = getEntityById(mainStore, imageId);
      const crate = cache.get(row.ro_crate_id);
      const crateDirPath = crateDirPathFromEntityId(row.ro_crate_id);
      const imagePath = crateRelativeEntityId(row.ro_crate_id, imageId);
      const record = readImageRecord(crate, imagePath);
      // Same stale-index case mergeNames handles: one row the crates no
      // longer back must not stop the rest being renamed.
      if (!record) {
        unreadable.push(imageId);
        continue;
      }
      syncImageIndexFromCrate(mainStore, crateDirPath, imagePath, record);
    }

    // The root crate holds the identity itself, and may hold it for
    // somebody no photo depicts at all, so it is renamed whether or not
    // any image turned up above.
    const rootCrate = await loadCrateForEdit(cache, crateEntityId(''));
    renameSubjectInCrate(rootCrate, { subjectId, newName });
    syncRootCrateSubjects(rootCrate, listDepictedSubjects(mainStore));

    await saveEditedCrates(cache);
    // The identity's own index row: same id, new name, and the same
    // crate it was already attached to — the index records a person
    // against whichever crate first depicted them, and a rename is no
    // reason to move that. A person no image depicts has no row here
    // at all, which is correct: this index covers what is depicted.
    const existingRow = getEntityById(mainStore, subjectId);
    if (existingRow) {
      upsertEntity(mainStore, {
        id: subjectId, roCrateId: existingRow.ro_crate_id, entityType: existingRow.entity_type, name: newName,
      });
    }
    await persistStore(mainStore);

    renamePersonInFacesStore(facesStore, { personId: subjectId, newName });
    await persistStore(facesStore);

    const facesCrate = await loadOrCreateFacesCrate(fsAdapter);
    let facesCrateChanged = false;
    for (const entity of facesCrate.entities()) {
      if (unwrapId(entity.about) !== subjectId || entity.name === undefined) continue;
      entity.name = newName;
      facesCrateChanged = true;
    }
    if (facesCrateChanged) await saveFacesCrate(fsAdapter, facesCrate);

    return { imagesUpdated: touchedImageIds.size - unreadable.length, unreadable };
  }

  async function handleRequest({ method, path, query = {}, body = null }) {
    if (method === 'GET' && path === '/') {
      // facetCounts, not the paginated GET /entities — see
      // webview/app.js's fetchKnownPeople, fixed for the exact same
      // reason: this list backs a UI that must show every Person, not
      // just however many happen to fit a default page.
      const rows = facetCounts(mainStore, 'people', {});
      return json(200, { people: rows.map((row) => ({ name: row.value, imageCount: row.count })) });
    }

    if (method === 'POST' && path === '/merge') {
      const sourceNames = Array.isArray(body?.sourceNames)
        ? [...new Set(body.sourceNames.map((name) => String(name).trim()).filter(Boolean))]
        : [];
      const targetName = typeof body?.targetName === 'string' ? body.targetName.trim() : '';
      // One name is a rename, several a merge (see this handler's own
      // doc comment for why that is a labelling difference rather than
      // two operations) — so the only real requirement is at least one.
      if (sourceNames.length === 0) return badRequest('sourceNames must list at least one person');
      if (!targetName) return badRequest('targetName is required');

      // Serialized against every other crate-writing request (see
      // writeQueue.js) — a merge is a read-modify-write of every crate
      // that depicts any of these names, plus both SQLite indexes, the
      // same shape as /edit/* and /faces/confirm, and can race against
      // any of them the same way.
      return serializeWrites(async () => {
        const { targetId, imagesUpdated, unreadable } = await mergeNames({ sourceNames, targetName });
        return json(200, { ok: true, targetId, targetName, imagesUpdated, unreadable });
      });
    }

    // The profile-driven editor for one person's canonical record, the
    // node in the root crate that holds everything known about them
    // (see crateBuilder.js's syncRootCrateSubjects: the sub-collection
    // crates carry a minimal copy of each identity so they read
    // standalone, and this is the one meant to carry the rest).
    //
    // The fields come from the MASP profile, not from this file — the
    // editor hands back whatever `#MainPersonClass` declares, so adding
    // a property to the profile and running `npm run sync:masp` adds a
    // field here and in the form without a code change. See
    // src/masp/profileEditor.js.
    if (method === 'GET' && path === '/person') {
      const name = typeof query.name === 'string' ? query.name.trim() : '';
      if (!name) return badRequest('name is required');

      const editor = await collectionProfileEditor(fsAdapter);
      const rootCrate = await loadCrateForEdit(new Map(), crateEntityId(''));
      // By current name, since that is what the People tab has. The id
      // is whatever this person was minted under, which after a rename
      // no longer reads like their name (see subjects.js).
      const id = resolveSubjectId(name, 'Person', { crate: rootCrate });
      // A person the index knows about but the root crate has no node
      // for — a collection scanned by a version that did not write them
      // there yet — is still editable: the node is put in this throwaway
      // copy of the crate so the fields have something to read, and the
      // POST below creates it for real on the first save.
      if (!rootCrate.getEntity(id)) rootCrate.addEntity({ '@id': id, '@type': 'Person', name });

      return json(200, {
        id,
        name,
        class: editor.classInfo(MAIN_PERSON_CLASS),
        fields: await withReferenceOptions(editor, rootCrate, editor.fields(MAIN_PERSON_CLASS), id),
        values: editor.read(rootCrate, id, MAIN_PERSON_CLASS),
        check: await editor.check(rootCrate, id, MAIN_PERSON_CLASS),
        relationships: await describeRelationships(editor, rootCrate, id),
        relationshipClasses: await Promise.all(availableRelationshipClasses(editor).map(async (classRuleId) => ({
          ...editor.classInfo(classRuleId),
          fields: await withReferenceOptions(editor, rootCrate, editor.fields(classRuleId), null),
          participants: participantFields(editor, classRuleId),
          // Two slots taking the same kind of thing can be filled the
          // wrong way round, and only the person typing knows which
          // way is right (see swappableParticipants).
          swappable: swappableParticipants(editor, classRuleId),
        }))),
      });
    }

    // Creating or updating a relationship between people. One route for
    // both, the way the editor itself is: a relationship with an id is
    // the one being changed, and without one is a new one, and nothing
    // about the request differs otherwise.
    if (method === 'POST' && path === '/relationship') {
      const classRuleId = typeof body?.classRuleId === 'string' ? body.classRuleId : '';
      const editor = await collectionProfileEditor(fsAdapter);
      const offered = availableRelationshipClasses(editor);
      if (!offered.includes(classRuleId)) {
        return badRequest(`classRuleId must be one of: ${offered.join(', ') || '(this profile declares none)'}`);
      }
      const submitted = body?.values && typeof body.values === 'object' ? body.values : null;
      if (!submitted) return badRequest('values is required');
      const relationshipId = typeof body?.id === 'string' && body.id ? body.id : null;

      const scratch = await loadCrateForEdit(new Map(), crateEntityId(''));
      const fields = await withReferenceOptions(editor, scratch, editor.fields(classRuleId), null);
      const resolved = resolveReferences(fields, submitted);
      if (resolved.problems.length > 0) {
        return json(422, { error: 'Some values do not match the profile', problems: resolved.problems });
      }

      // Checked on a throwaway copy first, so a rejected relationship
      // leaves nothing behind — including the term definitions `write`
      // copies in as it goes.
      const trial = writeRelationship(editor, scratch, { id: relationshipId, classRuleId, values: resolved.values });
      const check = await editor.check(scratch, trial.id, classRuleId);
      const bad = check.problems.filter(({ field }) => asValueArray(resolved.values[field]).some((value) => String(value).trim() !== ''));
      if (bad.length > 0) {
        return json(422, { error: 'Some values do not match the profile', problems: bad, check });
      }

      return serializeWrites(async () => {
        const cache = new Map();
        const rootCrate = await loadCrateForEdit(cache, crateEntityId(''));
        const { id, created } = writeRelationship(editor, rootCrate, { id: relationshipId, classRuleId, values: resolved.values });
        await saveEditedCrates(cache);
        return json(200, { ok: true, id, created, classRuleId, check });
      });
    }

    if (method === 'POST' && path === '/relationship/delete') {
      const relationshipId = typeof body?.id === 'string' ? body.id : '';
      if (!relationshipId) return badRequest('id is required');

      return serializeWrites(async () => {
        const cache = new Map();
        const rootCrate = await loadCrateForEdit(cache, crateEntityId(''));
        const removed = deleteRelationship(rootCrate, relationshipId);
        if (removed) await saveEditedCrates(cache);
        return json(200, { ok: true, removed });
      });
    }

    if (method === 'POST' && path === '/person') {
      const originalName = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!originalName) return badRequest('name is required (the person being edited)');
      const submitted = body?.values && typeof body.values === 'object' ? body.values : null;
      if (!submitted) return badRequest('values is required');

      const editor = await collectionProfileEditor(fsAdapter);
      const newNames = asValueArray(submitted.name).filter((value) => String(value).trim() !== '');
      // The profile does not cap `name` at one value, but rocphotos
      // cannot store two: a person's entity id is derived from their
      // name (see db/store.js's personEntityId), so a second name is a
      // second person. Refused here rather than in the profile editor,
      // which has no business overriding what a profile says — this is
      // an application limit, and the profile should grow an
      // sh:maxCount of 1 to match it.
      if (newNames.length !== 1) return badRequest('A person needs exactly one name');
      const newName = String(newNames[0]).trim();

      // Checked before anything is written, on a copy of the root crate
      // that is then thrown away, so a rejected edit leaves no trace.
      const scratch = await loadCrateForEdit(new Map(), crateEntityId(''));

      // An id is minted once and frozen (see subjects.js), so this
      // person keeps theirs whatever happens to their name. What the
      // new name means depends on whether anybody else already has it:
      //
      //   nobody         -> a rename. The id does not move and no
      //                     reference anywhere changes.
      //   somebody else  -> a merge, since a name identifies one person
      //                     collection-wide. Two identities collapse
      //                     into one, exactly as before.
      //
      // These used to be the same operation only because the id was
      // computed from the name, which made every rename a move.
      const originalId = resolveSubjectId(originalName, 'Person', { crate: scratch });
      const existingWithNewName = subjectIdInCrate(scratch, newName, 'Person');
      const mergingInto = existingWithNewName && existingWithNewName !== originalId ? existingWithNewName : null;
      const newId = mergingInto ?? originalId;

      if (!scratch.getEntity(newId)) scratch.addEntity({ '@id': newId, '@type': 'Person', name: newName });
      else renameSubjectInCrate(scratch, { subjectId: newId, newName });

      // A reference field comes back as whatever the picker sent — an
      // id, or the name somebody typed — and has to become an id before
      // anything is written or checked. Resolved against the same
      // candidate list the form was given, so the two agree about who
      // exists.
      const fields = await withReferenceOptions(editor, scratch, editor.fields(MAIN_PERSON_CLASS), newId);
      const resolved = resolveReferences(fields, { ...submitted, name: newName });
      if (resolved.problems.length > 0) {
        return json(422, { error: 'Some values do not match the profile', problems: resolved.problems });
      }
      const values = resolved.values;

      editor.write(scratch, newId, values, MAIN_PERSON_CLASS);
      const check = await editor.check(scratch, newId, MAIN_PERSON_CLASS);

      // A field left empty is incomplete, not wrong: the profile
      // requires a description and a birth date, and refusing to save
      // until both are known would make it impossible to record the one
      // that is. A field that was filled in and still fails is wrong —
      // a birth date of "last Tuesday" — and that is refused, because
      // saving it would put a value in the crate that no reader of the
      // profile can interpret.
      const bad = check.problems.filter(({ field }) => asValueArray(values[field]).some((value) => String(value).trim() !== ''));
      if (bad.length > 0) {
        return json(422, { error: 'Some values do not match the profile', problems: bad, check });
      }

      return serializeWrites(async () => {
        const applyValues = (rootCrate) => {
          if (!rootCrate.getEntity(newId)) rootCrate.addEntity({ '@id': newId, '@type': 'Person', name: newName });
          editor.write(rootCrate, newId, values, MAIN_PERSON_CLASS);
        };

        if (mergingInto) {
          // Two identities collapse into one. The values go on inside
          // that same read-modify-write because the merge replaces the
          // surviving node's properties — applied before it, the new
          // description and birth date would be discarded along with
          // the identity that lost.
          const { imagesUpdated, unreadable } = await mergeNames({ sourceNames: [originalName], targetName: newName, editRootCrate: applyValues });
          return json(200, { ok: true, id: newId, name: newName, renamedFrom: originalName, mergedInto: newId, imagesUpdated, unreadable, check });
        }

        if (newName !== originalName) {
          // A plain rename: the id stays, so nothing is re-pointed.
          // Every copy of the label follows — the identity's own name
          // in each crate, the name each region duplicates, the index
          // row and facets, and the faces index.
          const { imagesUpdated, unreadable } = await renameSubject({ subjectId: originalId, oldName: originalName, newName });
          const cache = new Map();
          applyValues(await loadCrateForEdit(cache, crateEntityId('')));
          await saveEditedCrates(cache);
          return json(200, { ok: true, id: newId, name: newName, renamedFrom: originalName, mergedInto: null, imagesUpdated, unreadable, check });
        }

        // Neither: nothing outside the root crate is affected. These
        // values are deliberately not copied into the index:
        // `entities.description` is rewritten from the photo's own
        // caption every time an image depicting this person is scanned
        // (see scanImage.js), so a canonical description kept there
        // would survive only until the next scan. The root crate is the
        // one place it lives.
        const cache = new Map();
        const rootCrate = await loadCrateForEdit(cache, crateEntityId(''));
        applyValues(rootCrate);
        await saveEditedCrates(cache);
        return json(200, { ok: true, id: newId, name: newName, renamedFrom: null, mergedInto: null, imagesUpdated: 0, unreadable: [], check });
      });
    }

    return json(404, { error: `No route for ${method} ${path}` });
  }

  return handleRequest;
}

// A reference read back under { array: true } arrives as a one-element
// array; this is the one place in this file that needs to look inside.
function unwrapId(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return first && typeof first === 'object' ? first['@id'] : undefined;
}

function asValueArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Each relationship a person is in, with everything a form needs to
 * show and change it: the class it belongs to, its current values, and
 * what the profile makes of them.
 *
 * The other people are named rather than only identified, because a
 * list of relationships that reads "arcp://name,rocphoto/person/..."
 * is no use to anybody.
 */
async function describeRelationships(editor, crate, personId) {
  const described = [];
  for (const relationship of await relationshipsFor(editor, crate, personId)) {
    const labels = new Map(editor.fields(relationship.classRuleId).map((field) => [field.name, field.label]));
    const others = [];
    // Which slot each person is in, not just who they are. A person
    // turns up in a parent-child relationship from either end, and
    // "with Peter" does not say whether Peter is the parent.
    let role = null;
    for (const field of participantFields(editor, relationship.classRuleId)) {
      for (const value of relationship.values[field] ?? []) {
        const id = value?.['@id'];
        if (!id) continue;
        if (id === personId) {
          role = labels.get(field) ?? field;
          continue;
        }
        const entity = crate.getEntity(id);
        others.push({
          field,
          fieldLabel: labels.get(field) ?? field,
          id,
          name: (Array.isArray(entity?.name) ? entity.name[0] : entity?.name) ?? id,
        });
      }
    }
    described.push({ ...relationship, role, others });
  }
  return described;
}

/**
 * Fills in `options` for every field whose value is a reference to
 * another entity — the "crate lookup" a picker needs.
 *
 * Which entities qualify is the profile's answer, not this file's: the
 * editor runs the class rule the field's range names (see
 * createProfileEditor's candidates). So `parent`, whose range is
 * `#MainPersonClass`, offers the people in the root crate, and a field
 * added later pointing at some other class offers that class's entities
 * with no change here.
 *
 * `exclude` drops the entity being edited from its own list. Nobody is
 * their own parent, and more generally an entity offered as a candidate
 * reference for itself is never what somebody meant — but that is a
 * judgement about editing, not something the profile says, which is why
 * it is applied here and not in the component.
 */
async function withReferenceOptions(editor, crate, fields, exclude) {
  const byClass = new Map();
  const result = [];
  for (const field of fields) {
    if (field.referenceClasses.length === 0) {
      result.push(field);
      continue;
    }
    const options = [];
    for (const classRuleId of field.referenceClasses) {
      if (!byClass.has(classRuleId)) byClass.set(classRuleId, await editor.candidates(crate, classRuleId));
      for (const candidate of byClass.get(classRuleId)) {
        if (candidate.id === exclude || options.some((kept) => kept.id === candidate.id)) continue;
        options.push(candidate);
      }
    }
    result.push({ ...field, options });
  }
  return result;
}

/**
 * Turns what a form submitted for a reference field into entity ids.
 *
 * A picker sends back whichever of the two the person actually chose:
 * the id, when they picked from the list, or the name they typed. Both
 * are accepted, because a name identifies a person in this collection
 * exactly as well as an id does (identity is name-derived), and
 * rejecting a correctly-typed name on a technicality would be perverse.
 * Anything matching neither is refused by name, which is a far more
 * useful thing to read than the validator's "did not match any of the
 * expected ranges".
 *
 * @returns {{values: object, problems: Array<{field: string, message: string}>}}
 */
function resolveReferences(fields, values) {
  const resolved = { ...values };
  const problems = [];

  for (const field of fields) {
    if (field.referenceClasses.length === 0 || !(field.name in values)) continue;
    const options = field.options ?? [];
    const byId = new Map(options.map((option) => [option.id, option.id]));
    const byName = new Map(options.map((option) => [option.name, option.id]));

    const out = [];
    for (const raw of asValueArray(values[field.name])) {
      const value = typeof raw === 'object' && raw !== null ? raw['@id'] : raw;
      const text = String(value ?? '').trim();
      if (text === '') continue;
      const id = byId.get(text) ?? byName.get(text);
      if (id === undefined) {
        problems.push({ field: field.name, message: `There is nobody called "${text}" in this collection. Pick someone already recorded here.` });
        continue;
      }
      if (!out.includes(id)) out.push(id);
    }
    resolved[field.name] = out;
  }

  return { values: resolved, problems };
}
