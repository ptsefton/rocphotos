import {
  getEntityById,
  deleteEntityById,
  searchEntities,
  countSearchResults,
  facetCounts,
  personEntityId,
  crateDirPathFromEntityId,
  crateRelativeEntityId,
  ENTITY_TYPE_IMAGE,
} from '../db/store.js';
import { CRATE_FILE_NAME, loadOrCreateCrate, serializeCrate, readImageRecord, renamePersonInCrate } from '../crateBuilder.js';
import { syncImageIndexFromCrate } from '../scanImage.js';
import { joinPath } from '../pathUtils.js';
import { serializeWrites } from '../writeQueue.js';
import { mergePersonInFacesStore } from '../faces/store.js';
import { loadOrCreateFacesCrate, saveFacesCrate } from '../faces/crate.js';

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

  async function handleRequest({ method, path, body = null }) {
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

      const targetId = personEntityId(targetName);
      const sourceIds = sourceNames.map((name) => personEntityId(name));

      // Serialized against every other crate-writing request (see
      // writeQueue.js) — a merge is a read-modify-write of every crate
      // that depicts any of these names, plus both SQLite indexes, the
      // same shape as /edit/* and /faces/confirm, and can race against
      // any of them the same way.
      return serializeWrites(async () => {
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
              renamePersonInCrate(crate, imagePath, { sourceId, targetId, targetName, subjectType: 'Person' });
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
          for (const crate of cache.values()) {
            if (crate.getEntity(sourceId)) crate.deleteEntity(sourceId);
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
        for (const imageId of touchedImageIds) {
          const row = getEntityById(mainStore, imageId);
          const crate = cache.get(row.ro_crate_id);
          const crateDirPath = crateDirPathFromEntityId(row.ro_crate_id);
          const imagePath = crateRelativeEntityId(row.ro_crate_id, imageId);
          syncImageIndexFromCrate(mainStore, crateDirPath, imagePath, readImageRecord(crate, imagePath));
        }

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

        return json(200, { ok: true, targetId, targetName, imagesUpdated: touchedImageIds.size });
      });
    }

    return json(404, { error: `No route for ${method} ${path}` });
  }

  return handleRequest;
}
