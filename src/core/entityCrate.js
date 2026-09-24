import { loadOrCreateCrate, CRATE_FILE_NAME } from './crateBuilder.js';
import { crateRelativeEntityId, crateDirPathFromEntityId } from './db/store.js';
import { joinPath } from './pathUtils.js';

// An entity's own JSON.stringify/toJSON deliberately returns the
// *unresolved* form (correct for what gets written to disk) — link:true's
// resolution (see loadOrCreateCrate) only applies to direct property
// access, not serialization. This builds a plain, resolved object first,
// so a reference such as an image's thumbnail or an EXIF PropertyValue
// comes through as the full referenced entity rather than a bare
// {'@id': ...} stub.
function resolveEntityShallow(entity) {
  const plain = {};
  for (const key of Object.keys(entity)) {
    plain[key] = entity[key];
  }
  return plain;
}

/**
 * Loads a whole crate (not just one of its entities), from cache if this
 * `crateCache` already holds it. Shared by loadEntityFromCrate below and
 * by any caller that needs to walk more than one of a crate's own
 * entities at once (e.g. an album's `hasPart` proxies — see
 * albumMemberIds in crateBuilder.js) rather than only ever resolving a
 * single top-level one.
 *
 * `crateCache`, supplied by the caller, is a Map used to avoid reading
 * and parsing the same crate file again for every one of its entities;
 * pass a fresh Map per request/operation, not a long-lived shared one,
 * unless that shared cache is also correctly invalidated on every write
 * to the same crate (as the AROCAPI handler's own read routes do — see
 * createHandler's crateCache param).
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {Map<string, import('ro-crate').ROCrate>} crateCache
 * @param {string} roCrateId
 * @returns {Promise<import('ro-crate').ROCrate>}
 */
export async function loadRawCrate(fsAdapter, crateCache, roCrateId) {
  let crate = crateCache.get(roCrateId);
  if (!crate) {
    const crateDirPath = crateDirPathFromEntityId(roCrateId);
    const cratePath = joinPath(crateDirPath, CRATE_FILE_NAME);
    const json = (await fsAdapter.exists(cratePath))
      ? new TextDecoder().decode(await fsAdapter.readFile(cratePath))
      : null;
    crate = loadOrCreateCrate(json);
    crateCache.set(roCrateId, crate);
  }
  return crate;
}

/**
 * Loads an entity's full, resolved data straight out of the crate file it
 * actually lives in — per AROCAPI, an entity's full metadata is its own
 * RO-Crate JSON-LD document. `roCrateId` and `entityId` are both in the
 * index's collection-relative id form (entities.ro_crate_id / entities.id
 * — see crateEntityId/imageEntityId in db/store.js); this converts to the
 * crate-relative id actually used inside that crate's own
 * ro-crate-metadata.json before looking the entity up there.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {Map<string, import('ro-crate').ROCrate>} crateCache - see loadRawCrate
 * @param {string} roCrateId
 * @param {string} entityId
 * @returns {Promise<object|null>}
 */
export async function loadEntityFromCrate(fsAdapter, crateCache, roCrateId, entityId) {
  const crate = await loadRawCrate(fsAdapter, crateCache, roCrateId);
  const entity = crate.getEntity(crateRelativeEntityId(roCrateId, entityId));
  return entity ? resolveEntityShallow(entity) : null;
}
