import { resolveSubjectIdFromIndex } from '../subjects.js';
import {
  getEntityById,
  getFileById,
  crateDirPathFromEntityId,
  crateRelativeEntityId,
  searchEntities,
  ENTITY_TYPE_IMAGE,
} from '../db/store.js';
import { CRATE_FILE_NAME, loadOrCreateCrate, serializeCrate, readImageRecord, addStandoffFaceRegion } from '../crateBuilder.js';
import { rescanImageMetadata, syncImageIndexFromCrate } from '../scanImage.js';
import { joinPath } from '../pathUtils.js';
import { findClosestReference, clusterUnmatched } from './matching.js';
import { correctAreaForOrientation } from './orientation.js';
import { SAME_FACE_OVERLAP_THRESHOLD, bestOverlapEitherOrientation } from './geometry.js';
import { serializeWrites } from '../writeQueue.js';
import {
  isImageAlreadyScanned,
  markImageScanned,
  isBackfillFullyChecked,
  markBackfillFullyChecked,
  listReferenceFaces,
  addReferenceFace,
  hasReferenceForPersonOnImage,
  isRegionUndetectable,
  markRegionUndetectable,
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

// Marks an image fully backfill-checked the moment its last outstanding
// named region gets a reference, rather than waiting for some later
// /existing-regions call to notice — without this, an image whose final
// missing person is resolved in this very pass still shows up as
// needing a check for one more whole "Recognize Faces" click before
// settling, even though nothing further is actually needed (confirmed
// against a real collection: the decision inside /existing-regions is
// made from a snapshot taken before that same pass's own
// /backfill-reference calls run, so it is always one pass behind).
async function markImageIfNowFullyBackfilled(fsAdapter, mainStore, facesStore, imageId, modelName, modelVersion) {
  const existingRegions = await loadExistingFaceRegions(fsAdapter, mainStore, new Map(), imageId);
  const stillMissing = existingRegions.some((region) => {
    const personId = resolveSubjectIdFromIndex(mainStore, region.name);
    return (
      !hasReferenceForPersonOnImage(facesStore, imageId, personId, modelName, modelVersion)
      && !isRegionUndetectable(facesStore, imageId, personId, modelName, modelVersion)
    );
  });
  if (stillMissing) return;
  const fileRow = getFileById(mainStore, imageId);
  if (!fileRow) return;
  const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
  markBackfillFullyChecked(facesStore, { imageId, fileMtime: modifiedTime, modelName, modelVersion });
}

// Every already-named Face region on an image, in both the raw and the
// orientation-corrected form of its Area (see orientation.js) — shared
// by /existing-regions (to find regions needing a reference embedding)
// and /detections (to recognise a freshly detected face as one of these
// already-tagged ones, rather than offering it for review as if it were
// new — see /detections' own comment for why that check exists). Both
// forms are kept, not just the corrected one: confirmed against two real
// files that different tools disagree about which frame Area is measured
// against for the same Orientation value (one needs correcting, one
// actively breaks if corrected), so callers try both against a real
// detected face rather than trusting either on its own — see
// geometry.js's bestOverlapEitherOrientation.
// `requestCrateCache` is caller-provided so /existing-regions can share
// one across several images in the same request; /detections, handling
// only one image, can just pass a fresh Map.
async function loadExistingFaceRegions(fsAdapter, mainStore, requestCrateCache, imageId) {
  const imageRow = getEntityById(mainStore, imageId);
  if (!imageRow) return [];
  if (!requestCrateCache.has(imageRow.ro_crate_id)) {
    requestCrateCache.set(imageRow.ro_crate_id, (await loadCrateForImage(fsAdapter, imageRow.ro_crate_id)).crate);
  }
  const crate = requestCrateCache.get(imageRow.ro_crate_id);
  const crateRelativeId = crateRelativeEntityId(imageRow.ro_crate_id, imageId);
  const record = readImageRecord(crate, crateRelativeId);
  if (!record) return [];
  const orientation = record.exifEntries.find((entry) => entry.name === 'Orientation')?.value;

  return record.regions
    .map((region, index) => ({ region, index }))
    .filter(({ region }) => region.type === 'Face' && region.name && region.area)
    .map(({ region, index }) => ({
      index,
      name: region.name,
      rawArea: region.area,
      correctedArea: correctAreaForOrientation(region.area, orientation),
    }));
}

/**
 * Creates a pure, transport-agnostic handler for the `/faces/*` routes
 * (mounted at `/api/faces/*` — see bin/rocphotos.js's `serve` and
 * src/sw.js) backing the web view's "Recognize Faces" workflow (see
 * Spec.md's Face Recognition section). Detection and embedding both run
 * client-side (face-api.js, in the browser, in every run mode); this
 * handler only matches embeddings the browser already computed against
 * the reference set, stores pending detections for review, and — only
 * when a `writeFaceRegion` implementation is supplied AND
 * `writeBackEnabled` is true — writes a confirmed match back into the
 * photo file itself via the system `exiftool` binary. /faces/confirm
 * refuses (with a distinct error for each reason) if either is missing:
 * no `writeFaceRegion` means this run mode or machine cannot do it at
 * all (the browser-only Service-Worker run mode, which cannot shell out
 * to an external process; or exiftool not being installed); `writeBackEnabled`
 * false means it could, but this collection has not opted in (see
 * config.js's loadWriteMetadataToFilesSetting — off by default, since
 * exiftool's own writeback has no backup of a file's previous bytes
 * beyond whatever the user's own backups already cover).
 *
 * @param {object} deps
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver & {persist?: () => Promise<void>}} deps.mainStore - the main photo index
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver & {persist?: () => Promise<void>}} deps.facesStore - the faces companion index (_rocphotos/faces/faces-index.sqlite)
 * @param {import('../fsAdapter.js').FsAdapter} deps.fsAdapter
 * @param {(relativePath: string, options: {name: string, area: object, imageWidth: number, imageHeight: number}) => Promise<void>} [deps.writeFaceRegion]
 * @param {boolean} [deps.writeBackEnabled] - this collection's own opt-in (see loadWriteMetadataToFilesSetting in config.js) — defaults to false (refuse) rather than true, so a caller that forgets to pass it fails safe instead of silently writing to original files
 * @param {Map<string, import('ro-crate').ROCrate>} [deps.crateCache] - the AROCAPI handler's own long-lived read cache (see arocapi/handler.js), shared here so /confirm's crate write is reflected immediately in GET /entity/{id}/metadata (the viewer's tags and its "Show faces" overlay) rather than only after the crate is next evicted/reloaded. Optional — a caller that never shares one (tests; the browser SW, which mints a fresh handler and cache per request anyway) just does not get this cross-handler sync, which is harmless in those cases.
 */
export function createFacesHandler({ mainStore, facesStore, fsAdapter, writeFaceRegion = null, writeBackEnabled = false, crateCache = null }) {
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
      // Deliberately a separate, request-local cache from the shared
      // crateCache param above (used by /confirm to keep AROCAPI's own
      // read cache in sync) — this one only ever avoids re-reading the
      // same crate twice within this one request, always starting fresh
      // from disk, so it is never at risk of the staleness that param
      // exists to prevent. Named differently so a future change can't
      // absent-mindedly conflate the two.
      const requestCrateCache = new Map();
      for (const imageId of imageIds) {
        // isBackfillFullyChecked skips reading/parsing this image's
        // crate at all once every named region on it already has a
        // reference — without it, every single "Recognize Faces" click
        // re-examines every tagged image in the whole collection, even
        // ones nothing has changed about since the last click, which is
        // the entire visible cost of this step once the collection's
        // reference set has caught up.
        const fileRow = getFileById(mainStore, imageId);
        if (!fileRow) continue;
        const { modifiedTime } = await fsAdapter.stat(fileRow.relative_path);
        if (isBackfillFullyChecked(facesStore, imageId, modifiedTime, modelName, modelVersion)) continue;

        const existingRegions = await loadExistingFaceRegions(fsAdapter, mainStore, requestCrateCache, imageId);
        let allResolved = true;
        for (const { index, name, rawArea, correctedArea } of existingRegions) {
          const personId = resolveSubjectIdFromIndex(mainStore, name);
          if (hasReferenceForPersonOnImage(facesStore, imageId, personId, modelName, modelVersion)) continue;
          // Already tried and given up on (see /backfill-undetectable) —
          // treated the same as a real reference here so it is never
          // listed again, but never counted as a match anywhere else.
          if (isRegionUndetectable(facesStore, imageId, personId, modelName, modelVersion)) continue;
          allResolved = false;
          regions.push({ imageId, sourceRegionId: `${imageId}#region-${index}`, personName: name, rawArea, correctedArea });
        }
        // Only marked done when nothing on this image was left needing a
        // reference this pass — an image with a region whose embedding
        // fails to compute and has not yet been reported as undetectable
        // (see /backfill-undetectable) stays unmarked, so it is looked at
        // again (and only that one region retried) next time, rather than
        // the failure being silently permanent.
        if (allResolved) {
          markBackfillFullyChecked(facesStore, { imageId, fileMtime: modifiedTime, modelName, modelVersion });
        }
      }
      await persistStore(facesStore);
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

      const personId = resolveSubjectIdFromIndex(mainStore, personName);
      // /existing-regions only checks this at listing time, against a
      // single snapshot of the reference set — if the same image has
      // more than one region for the same Person (duplicate regions from
      // before this was fixed, or any other reason), all of them come
      // back in that one listing (since none are backfilled yet at that
      // moment) and would otherwise all be saved here in the same pass,
      // regardless of the listing check. Confirmed as a real bug: a
      // photo with 5 duplicate same-named regions produced 5 reference
      // rows in a single "Recognize Faces" run against a completely
      // empty reference set. Checking again here, at the point of
      // actually saving, is what makes this genuinely idempotent.
      if (hasReferenceForPersonOnImage(facesStore, sourceImageId, personId, modelName, modelVersion)) {
        await markImageIfNowFullyBackfilled(fsAdapter, mainStore, facesStore, sourceImageId, modelName, modelVersion);
        await persistStore(facesStore);
        return json(200, { ok: true, skipped: true });
      }
      const referenceFaceId = crypto.randomUUID();
      addReferenceFace(facesStore, { id: referenceFaceId, personId, personName, sourceRegionId, sourceImageId, embedding, modelName, modelVersion });
      await markImageIfNowFullyBackfilled(fsAdapter, mainStore, facesStore, sourceImageId, modelName, modelVersion);
      await persistStore(facesStore);

      const facesCrate = await loadOrCreateFacesCrate(fsAdapter);
      addReferenceFaceEntity(facesCrate, { id: referenceFaceId, personId, personName, sourceRegionId, sourceImageId, embedding, modelName, modelVersion });
      await saveFacesCrate(fsAdapter, facesCrate);

      return json(200, { ok: true });
    }

    // Records that the browser genuinely tried (both a whole-image
    // detection pass and the zoomed, low-confidence crop fallback — see
    // webview/app.js's computeEmbeddingForKnownRegion) to compute an
    // embedding for an already-tagged region and could not — see
    // backfill_undetectable_regions in schema.js for why this is treated
    // as a permanent (until the model changes) rather than a transient
    // failure. Without this, a genuinely undetectable face (a full side
    // profile, one behind sunglasses, one lost to motion blur or extreme
    // backlighting — all confirmed against real examples) keeps its whole
    // image unmarked forever, so "Recognize Faces" re-reads and re-checks
    // that image's crate on every single run indefinitely.
    if (method === 'POST' && path === '/backfill-undetectable') {
      const { sourceImageId, personName, modelName, modelVersion } = body ?? {};
      if (!sourceImageId || !personName || !modelName || !modelVersion) {
        return badRequest('sourceImageId, personName, modelName, and modelVersion are required');
      }

      const personId = resolveSubjectIdFromIndex(mainStore, personName);
      markRegionUndetectable(facesStore, { imageId: sourceImageId, personId, personName, modelName, modelVersion });
      await markImageIfNowFullyBackfilled(fsAdapter, mainStore, facesStore, sourceImageId, modelName, modelVersion);
      await persistStore(facesStore);

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

      // face-api.js's own detector has no idea a region is already
      // named — without this, an already-tagged face gets detected
      // again as if it were new, suggested (a near-exact match to the
      // reference it was just backfilled from), and, if confirmed
      // (especially via "Confirm all"), written as a second, genuinely
      // duplicate MWG region on the same photo with a second reference
      // for the same (image, Person) pair — every single run. Anything
      // whose box substantially overlaps an existing named region is
      // the same physical face and is dropped here, never becoming a
      // detection at all.
      const existingRegions = await loadExistingFaceRegions(fsAdapter, mainStore, new Map(), imageId);
      const newFaces = faces.filter((face) => !existingRegions.some(
        (region) => bestOverlapEitherOrientation(face.box, region.rawArea, region.correctedArea) >= SAME_FACE_OVERLAP_THRESHOLD,
      ));

      const referenceFaces = listReferenceFaces(facesStore, modelName, modelVersion);
      const created = [];
      for (const face of newFaces) {
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

      // Groups pending detections with no suggested Person into
      // visually-similar clusters (webview/app.js renders these as an
      // "Unidentified cluster" group, the same one-action-confirms-all
      // shape as a suggested-Person match group, just with a name typed
      // in rather than proposed) — computed here, server-side, so raw
      // embeddings never need to go out over the API at all; only a
      // cluster's member ids do. A cluster of size 1 is exactly the
      // existing one-at-a-time "Unidentified" card, so only real (>1)
      // clusters are reported.
      const unclusterable = detections.filter((detection) => detection.status === 'pending' && !detection.suggested_person_id);
      const unmatchedClusters = clusterUnmatched(unclusterable)
        .filter((cluster) => cluster.length > 1)
        .map((cluster) => cluster.map((detection) => detection.id));

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
        unmatchedClusters,
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
    // always resolves to the same entity, a new one otherwise.
    //
    // Always recorded as a standoff region first (Spec.md's Face
    // Recognition section) — this alone is what makes a confirmation
    // fully visible (viewer tags, "Show faces", people/pets facets)
    // immediately, in every run mode, regardless of whether writing to
    // the original file is even possible here or has been turned on for
    // this collection. Writing a real MWG region into the photo file
    // itself (via the injected writeFaceRegion) is then attempted as a
    // genuinely separate, best-effort, optional step — not what makes a
    // confirmation "real"; its own failure (exiftool erroring, say)
    // never undoes or fails a confirmation that has already happened.
    if (method === 'POST' && path === '/confirm') {
      const personName = typeof body?.personName === 'string' ? body.personName.trim() : '';
      if (!personName) return badRequest('personName is required');

      // Everything below is a read-modify-write of a crate file and/or a
      // photo file (the standoff region, then writeFaceRegion +
      // rescanImageMetadata's crate write when write-back applies, then
      // the faces crate's own read-modify-write) — two of these
      // confirmations running at once, for the same image or even just
      // the same directory, can otherwise interleave and silently lose
      // whichever one's write finishes first (see writeQueue.js).
      // Confirmed as a real cause of data loss: batch-confirming several
      // people in the same folder in quick succession left only one of
      // two people actually tagged on a given photo, with the other
      // silently reverted and resurfacing as unidentified on the next
      // run. serializeWrites makes every confirmation across the whole
      // process wait its turn, however close together they arrive.
      return serializeWrites(async () => {
        const detection = getDetection(facesStore, body?.detectionId);
        if (!detection) return notFound();
        if (detection.status !== 'pending') return badRequest(`Detection is already "${detection.status}"`);

        const imageRow = getEntityById(mainStore, detection.image_id);
        const fileRow = getFileById(mainStore, detection.image_id);
        if (!imageRow || !fileRow) return notFound('Image no longer exists');

        const { crateDirPath, crate } = await loadCrateForImage(fsAdapter, imageRow.ro_crate_id);
        const imagePath = crateRelativeEntityId(imageRow.ro_crate_id, imageRow.id);
        const resolvedPersonId = resolveSubjectIdFromIndex(mainStore, personName);
        const box = { x: detection.box_x, y: detection.box_y, w: detection.box_w, h: detection.box_h };

        const standoff = addStandoffFaceRegion(crate, imagePath, {
          name: personName, subjectId: resolvedPersonId, subjectType: 'Person', box,
        });
        let sourceRegionId = standoff?.regionId;

        let writtenToFile = false;
        if (writeFaceRegion && writeBackEnabled) {
          try {
            await writeFaceRegion(fileRow.relative_path, { name: personName, area: box });
            const record = await rescanImageMetadata(fsAdapter, mainStore, crateDirPath, crate, imagePath);
            // The freshly-written region is always last among the
            // EXIF-derived ones (see the exiftool adapter, which only
            // ever appends) — kept for provenance/inspection only; see
            // hasReferenceForPersonOnImage for why the "already
            // backfilled?" check does not depend on this id being built
            // consistently.
            sourceRegionId = `${detection.image_id}#region-${record.regions.length - 1}`;
            writtenToFile = true;
          } catch (err) {
            // Left as a standoff region — still fully visible, just not
            // written into the file. Logged, not surfaced as a request
            // failure: the confirmation itself already succeeded.
            console.error(`Could not write a face region into ${fileRow.relative_path}: ${err.message}`);
          }
        }

        if (!writtenToFile) {
          // No file write happened this time (unavailable, turned off,
          // or it failed) — the crate already has the standoff region;
          // the index still needs to learn about it, the same way
          // rescanImageMetadata would if a file write had happened
          // instead.
          syncImageIndexFromCrate(mainStore, crateDirPath, imagePath, readImageRecord(crate, imagePath));
        }

        await fsAdapter.writeFile(joinPath(crateDirPath, CRATE_FILE_NAME), serializeCrate(crate));
        await persistStore(mainStore);
        // Keeps the AROCAPI handler's own read cache (if shared — see
        // createFacesHandler's crateCache param) from serving the
        // pre-confirm version of this crate to GET /entity/{id}/metadata
        // indefinitely: without this, the viewer's tags and "Show faces"
        // overlay would keep showing whatever this crate looked like the
        // last time anything read it, until the server was restarted.
        crateCache?.set(imageRow.ro_crate_id, crate);

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

        return json(200, { ok: true, personId: resolvedPersonId, personName, writtenToFile });
      });
    }

    return notFound(`No route for ${method} ${path}`);
  }

  return handleRequest;
}
