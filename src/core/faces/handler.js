import {
  getEntityById,
  getFileById,
  crateDirPathFromEntityId,
  crateRelativeEntityId,
  personEntityId,
  searchEntities,
  ENTITY_TYPE_IMAGE,
} from '../db/store.js';
import { CRATE_FILE_NAME, loadOrCreateCrate, serializeCrate, readImageRecord } from '../crateBuilder.js';
import { rescanImageMetadata } from '../scanImage.js';
import { joinPath } from '../pathUtils.js';
import { findClosestReference } from './matching.js';
import { correctAreaForOrientation } from './orientation.js';
import {
  isImageAlreadyScanned,
  markImageScanned,
  listReferenceFaces,
  addReferenceFace,
  hasReferenceFaceForRegion,
  addDetection,
  getDetection,
  listDetections,
  updateDetectionStatus,
  updateDetectionSuggestion,
} from './store.js';
import { loadOrCreateFacesCrate, saveFacesCrate, addReferenceFaceEntity } from './crate.js';

function json(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function notFound(message = 'Not found') {
  return json(404, { error: message });
}

function badRequest(message) {
  return json(400, { error: message });
}

async function persistStore(store) {
  await store.persist?.();
}

async function loadCrateForImage(fsAdapter, roCrateId) {
  const crateDirPath = crateDirPathFromEntityId(roCrateId);
  const cratePath = joinPath(crateDirPath, CRATE_FILE_NAME);
  const existingJson = (await fsAdapter.exists(cratePath)) ? new TextDecoder().decode(await fsAdapter.readFile(cratePath)) : null;
  return { crateDirPath, crate: loadOrCreateCrate(existingJson) };
}

/**
 * Creates a pure, transport-agnostic handler for the `/faces/*` routes
 * (mounted at `/api/faces/*` — see bin/rocphotos.js's `serve` and
 * src/sw.js) backing the web view's "Recognize Faces" workflow (see
 * Spec.md's Face Recognition section). Detection and embedding both run
 * client-side (face-api.js, in the browser, in every run mode); this
 * handler only matches embeddings the browser already computed against
 * the reference set, stores pending detections for review, and — when a
 * `writeFaceRegion` implementation is supplied — writes a confirmed
 * match back into the photo file itself via the system `exiftool`
 * binary. Without one (the browser-only Service-Worker run mode, which
 * cannot shell out to an external process), every route still works
 * except /faces/confirm, which returns a clear error instead.
 *
 * @param {object} deps
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver & {persist?: () => Promise<void>}} deps.mainStore - the main photo index
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver & {persist?: () => Promise<void>}} deps.facesStore - the faces companion index (_rocphotos/faces/faces-index.sqlite)
 * @param {import('../fsAdapter.js').FsAdapter} deps.fsAdapter
 * @param {(relativePath: string, options: {name: string, area: object, imageWidth: number, imageHeight: number}) => Promise<void>} [deps.writeFaceRegion]
 * @param {Map<string, import('ro-crate').ROCrate>} [deps.crateCache] - the AROCAPI handler's own long-lived read cache (see arocapi/handler.js), shared here so /confirm's crate write is reflected immediately in GET /entity/{id}/metadata (the viewer's tags and its "Show faces" overlay) rather than only after the crate is next evicted/reloaded. Optional — a caller that never shares one (tests; the browser SW, which mints a fresh handler and cache per request anyway) just does not get this cross-handler sync, which is harmless in those cases.
 */
export function createFacesHandler({ mainStore, facesStore, fsAdapter, writeFaceRegion = null, crateCache = null }) {
  async function handleRequest({ method, path, query = {}, body = null }) {
    if (method === 'POST' && path === '/scan-status') {
      const imageIds = Array.isArray(body?.imageIds) ? body.imageIds : [];
      const modelName = body?.modelName;
      const modelVersion = body?.modelVersion;
      if (!modelName || !modelVersion) return badRequest('modelName and modelVersion are required');

      const toScan = [];
      const scanned = [];
      for (const imageId of imageIds) {
        const fileRow = getFileById(mainStore, imageId);
        if (!fileRow) continue;
        const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
        if (isImageAlreadyScanned(facesStore, imageId, modifiedTime, modelName, modelVersion)) {
          scanned.push(imageId);
        } else {
          toScan.push(imageId);
        }
      }
      return json(200, { toScan, scanned });
    }

    // Faces tagged by another tool (digiKam, Lightroom) or confirmed in
    // an earlier rocphotos session already have a name and a box, but no
    // embedding of their own yet — the reference set otherwise starts
    // empty and never learns about them, so a first "Recognize Faces" run
    // has nothing to suggest even for someone tagged throughout the
    // whole collection. Lists each such region so the browser can crop
    // it, compute its embedding, and hand it back via /backfill-reference
    // below, before running detection on anything new.
    if (method === 'POST' && path === '/existing-regions') {
      const imageIds = Array.isArray(body?.imageIds) ? body.imageIds : [];
      const modelName = body?.modelName;
      const modelVersion = body?.modelVersion;
      if (!modelName || !modelVersion) return badRequest('modelName and modelVersion are required');

      const regions = [];
      const crateCache = new Map();
      for (const imageId of imageIds) {
        const imageRow = getEntityById(mainStore, imageId);
        if (!imageRow) continue;
        if (!crateCache.has(imageRow.ro_crate_id)) {
          crateCache.set(imageRow.ro_crate_id, (await loadCrateForImage(fsAdapter, imageRow.ro_crate_id)).crate);
        }
        const crate = crateCache.get(imageRow.ro_crate_id);
        const crateRelativeId = crateRelativeEntityId(imageRow.ro_crate_id, imageId);
        const record = readImageRecord(crate, crateRelativeId);
        if (!record) continue;
        const orientation = record.exifEntries.find((entry) => entry.name === 'Orientation')?.value;

        record.regions.forEach((region, index) => {
          if (region.type !== 'Face' || !region.name || !region.area) return;
          const sourceRegionId = `${imageId}#region-${index}`;
          if (hasReferenceFaceForRegion(facesStore, sourceRegionId, modelName, modelVersion)) return;
          regions.push({ imageId, sourceRegionId, personName: region.name, area: correctAreaForOrientation(region.area, orientation) });
        });
      }
      return json(200, { regions });
    }

    // Records an embedding the browser computed for an already-tagged
    // region (see /existing-regions above) — ground truth from a human
    // tagging tool, so unlike /confirm this never touches the photo file
    // or goes through a review step, it only grows the reference set.
    if (method === 'POST' && path === '/backfill-reference') {
      const { sourceImageId, sourceRegionId, personName, embedding, modelName, modelVersion } = body ?? {};
      if (!sourceImageId || !sourceRegionId || !personName || !Array.isArray(embedding) || !modelName || !modelVersion) {
        return badRequest('sourceImageId, sourceRegionId, personName, embedding, modelName, and modelVersion are required');
      }

      const personId = personEntityId(personName);
      const referenceFaceId = crypto.randomUUID();
      addReferenceFace(facesStore, { id: referenceFaceId, personId, personName, sourceRegionId, sourceImageId, embedding, modelName, modelVersion });
      await persistStore(facesStore);

      const facesCrate = await loadOrCreateFacesCrate(fsAdapter);
      addReferenceFaceEntity(facesCrate, { id: referenceFaceId, personId, personName, sourceRegionId, sourceImageId, embedding, modelName, modelVersion });
      await saveFacesCrate(fsAdapter, facesCrate);

      return json(200, { ok: true });
    }

    // Submits face-api.js's own detection+embedding output for one image,
    // computed entirely in the browser. Matches each face against the
    // current reference set (see faces/matching.js) — a close match to a
    // known Person suggests that name for review; a close match to a
    // "stranger" reference is auto-ignored and never shown; anything else
    // is unmatched, also pending review.
    if (method === 'POST' && path === '/detections') {
      const { imageId, modelName, modelVersion, faces } = body ?? {};
      if (!imageId || !modelName || !modelVersion || !Array.isArray(faces)) {
        return badRequest('imageId, modelName, modelVersion, and faces are required');
      }
      const fileRow = getFileById(mainStore, imageId);
      if (!fileRow) return notFound('No such image');

      const referenceFaces = listReferenceFaces(facesStore, modelName, modelVersion);
      const created = [];
      for (const face of faces) {
        const match = findClosestReference(face.embedding, referenceFaces);
        const isStranger = match && match.reference.personId === null;
        const detection = {
          id: crypto.randomUUID(),
          imageId,
          box: face.box,
          embedding: face.embedding,
          suggestedPersonId: match && !isStranger ? match.reference.personId : null,
          suggestedPersonName: match && !isStranger ? match.reference.personName : null,
          suggestedDistance: match ? match.distance : null,
          status: isStranger ? 'auto_ignored' : 'pending',
          modelName,
          modelVersion,
        };
        addDetection(facesStore, detection);
        created.push(detection);
      }

      const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
      markImageScanned(facesStore, { imageId, fileMtime: modifiedTime, modelName, modelVersion });
      await persistStore(facesStore);

      return json(200, { created: created.map(({ embedding, ...rest }) => rest) });
    }

    if (method === 'GET' && path === '/detections') {
      const status = query.status ?? 'pending';
      let imageIds = null;
      if (query.memberOf) {
        imageIds = searchEntities(mainStore, { memberOf: query.memberOf, entityType: ENTITY_TYPE_IMAGE }, { limit: 10000 })
          .map((row) => row.id);
      }
      const detections = listDetections(facesStore, { status: status === 'all' ? null : status, imageIds });

      const imageTitles = new Map();
      for (const detection of detections) {
        if (!imageTitles.has(detection.image_id)) {
          const row = getEntityById(mainStore, detection.image_id);
          imageTitles.set(detection.image_id, row?.title ?? row?.name ?? detection.image_id);
        }
      }

      return json(200, {
        total: detections.length,
        detections: detections.map((detection) => ({
          id: detection.id,
          imageId: detection.image_id,
          imageTitle: imageTitles.get(detection.image_id),
          box: { x: detection.box_x, y: detection.box_y, w: detection.box_w, h: detection.box_h },
          suggestedPersonId: detection.suggested_person_id,
          suggestedPersonName: detection.suggested_person_name,
          suggestedDistance: detection.suggested_distance,
          status: detection.status,
        })),
      });
    }

    if (method === 'POST' && path === '/ignore') {
      const detection = getDetection(facesStore, body?.detectionId);
      if (!detection) return notFound();
      updateDetectionStatus(facesStore, detection.id, { status: 'ignored' });
      await persistStore(facesStore);
      return json(200, { ok: true });
    }

    // Rejects the detection's current suggestion — "this is not who you
    // think it is" — and re-matches it against the reference set with
    // that Person (and every Person rejected for it before) excluded,
    // rather than just hiding it from the current review screen: without
    // this, a rejected suggestion would come right back the next time
    // detections are listed, since nothing about it would have actually
    // changed. Stays "pending" under whatever the next-best match is (or
    // with no suggestion at all), unless that next match is a "stranger"
    // reference, in which case it is auto-ignored the same as a fresh
    // detection would be.
    if (method === 'POST' && path === '/reject-suggestion') {
      const detection = getDetection(facesStore, body?.detectionId);
      if (!detection) return notFound();
      if (!detection.suggested_person_id) return badRequest('This detection has no suggestion to reject');

      const rejectedPersonIds = [...new Set([...detection.rejectedPersonIds, detection.suggested_person_id])];
      const referenceFaces = listReferenceFaces(facesStore, detection.model_name, detection.model_version)
        .filter((reference) => !rejectedPersonIds.includes(reference.personId));
      const match = findClosestReference(detection.embedding, referenceFaces);
      const isStranger = match && match.reference.personId === null;

      updateDetectionSuggestion(facesStore, detection.id, {
        suggestedPersonId: match && !isStranger ? match.reference.personId : null,
        suggestedPersonName: match && !isStranger ? match.reference.personName : null,
        suggestedDistance: match ? match.distance : null,
        status: isStranger ? 'auto_ignored' : 'pending',
        rejectedPersonIds,
      });
      await persistStore(facesStore);
      return json(200, { ok: true });
    }

    // Keeps the embedding as a permanent, unnamed reference (no `about`
    // link to any Person): a future detection that matches it closely is
    // auto-ignored the same way a match against a real Person is
    // suggested — see Spec.md. Used for a recurring face that will never
    // be identified (a stranger in the background of several photos).
    if (method === 'POST' && path === '/ignore-stranger') {
      const detection = getDetection(facesStore, body?.detectionId);
      if (!detection) return notFound();

      addReferenceFace(facesStore, {
        id: crypto.randomUUID(),
        personId: null,
        personName: null,
        sourceRegionId: null,
        sourceImageId: detection.image_id,
        embedding: detection.embedding,
        modelName: detection.model_name,
        modelVersion: detection.model_version,
      });
      updateDetectionStatus(facesStore, detection.id, { status: 'ignored' });
      await persistStore(facesStore);
      return json(200, { ok: true });
    }

    // Confirms a detection as a named Person — either accepting the
    // suggested name, correcting it to a different existing Person
    // ("Reassign"), or giving a brand new one ("New person"): all three
    // are the same operation here, since this app identifies a person by
    // name alone (see Spec.md's Person/Pet section) — the same name
    // always resolves to the same entity, a new one otherwise. Writes a
    // real MWG face region into the photo file itself (via the injected
    // writeFaceRegion), then re-extracts that one image's EXIF so the
    // change flows through the exact same region-ingestion pipeline a
    // digiKam- or Lightroom-tagged photo already goes through — no
        // separate code path for a machine-confirmed region's shape.
    if (method === 'POST' && path === '/confirm') {
      if (!writeFaceRegion) {
        return json(501, { error: 'Writing face regions back into photo files requires the desktop server (rocphotos serve), not the browser-only mode.' });
      }
      const personName = typeof body?.personName === 'string' ? body.personName.trim() : '';
      if (!personName) return badRequest('personName is required');

      const detection = getDetection(facesStore, body?.detectionId);
      if (!detection) return notFound();
      if (detection.status !== 'pending') return badRequest(`Detection is already "${detection.status}"`);

      const imageRow = getEntityById(mainStore, detection.image_id);
      const fileRow = getFileById(mainStore, detection.image_id);
      if (!imageRow || !fileRow) return notFound('Image no longer exists');

      const { crateDirPath, crate } = await loadCrateForImage(fsAdapter, imageRow.ro_crate_id);
      const imagePath = crateRelativeEntityId(imageRow.ro_crate_id, imageRow.id);

      await writeFaceRegion(fileRow.relative_path, {
        name: personName,
        area: { x: detection.box_x, y: detection.box_y, w: detection.box_w, h: detection.box_h },
      });

      const record = await rescanImageMetadata(fsAdapter, mainStore, crateDirPath, crate, imagePath);
      await fsAdapter.writeFile(joinPath(crateDirPath, CRATE_FILE_NAME), serializeCrate(crate));
      await persistStore(mainStore);
      // Keeps the AROCAPI handler's own read cache (if shared — see
      // createFacesHandler's crateCache param) from serving the
      // pre-confirm version of this crate to GET /entity/{id}/metadata
      // indefinitely: without this, the viewer's tags and "Show faces"
      // overlay would keep showing whatever this crate looked like the
      // last time anything read it, until the server was restarted.
      crateCache?.set(imageRow.ro_crate_id, crate);

      // The newly-written region is always last in the region list (see
      // the exiftool adapter, which only ever appends) — its id is
      // therefore derivable from the freshly re-read region count,
      // without needing writeFaceRegion to hand a region id back.
      // Built from detection.image_id (collection-relative — the same
      // form /existing-regions uses), not imagePath (crate-relative):
      // using the wrong one here meant a confirmed face's own region
      // never matched what a later "already backfilled?" check computed
      // for it, for any image outside the root crate — see
      // hasReferenceFaceForRegion and repairMismatchedSourceRegionIds.
      const sourceRegionId = `${detection.image_id}#region-${record.regions.length - 1}`;
      const resolvedPersonId = personEntityId(personName);

      const facesCrate = await loadOrCreateFacesCrate(fsAdapter);
      const referenceFaceId = crypto.randomUUID();
      addReferenceFace(facesStore, {
        id: referenceFaceId,
        personId: resolvedPersonId,
        personName,
        sourceRegionId,
        sourceImageId: detection.image_id,
        embedding: detection.embedding,
        modelName: detection.model_name,
        modelVersion: detection.model_version,
      });
      addReferenceFaceEntity(facesCrate, {
        id: referenceFaceId,
        personId: resolvedPersonId,
        personName,
        sourceRegionId,
        sourceImageId: detection.image_id,
        embedding: detection.embedding,
        modelName: detection.model_name,
        modelVersion: detection.model_version,
      });
      await saveFacesCrate(fsAdapter, facesCrate);

      updateDetectionStatus(facesStore, detection.id, { status: 'confirmed', resolvedPersonId, resolvedPersonName: personName });
      await persistStore(facesStore);

      return json(200, { ok: true, personId: resolvedPersonId, personName });
    }

    return notFound(`No route for ${method} ${path}`);
  }

  return handleRequest;
}
