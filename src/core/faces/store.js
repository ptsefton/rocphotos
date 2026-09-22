import { FACES_SCHEMA_SQL } from './schema.js';
import { FACES_DIR_NAME } from './crate.js';
import { joinPath } from '../pathUtils.js';

export const FACES_INDEX_FILE_NAME = joinPath(FACES_DIR_NAME, 'faces-index.sqlite');

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 */
export function ensureFacesSchema(driver) {
  driver.exec(FACES_SCHEMA_SQL);

  // Migration for a faces index built before rejected_person_ids existed
  // (see /faces/reject-suggestion) — CREATE TABLE IF NOT EXISTS above
  // does not add a column to an already-existing table, and this table
  // is real, user-facing state (an in-progress review) that should not
  // require deleting the whole faces index to pick up.
  const existingColumns = new Set(driver.all('PRAGMA table_info(detections)').map((row) => row.name));
  if (!existingColumns.has('rejected_person_ids')) {
    driver.exec("ALTER TABLE detections ADD COLUMN rejected_person_ids TEXT NOT NULL DEFAULT '[]'");
  }

  repairMismatchedSourceRegionIds(driver);
  deduplicateReferenceFaces(driver);
}

/**
 * One-off data repair, safe to run on every startup: a reference face
 * confirmed through /faces/confirm before the fix (see handler.js) had
 * its source_region_id built from the wrong (crate-relative, not
 * collection-relative) path for any image outside the root crate — so it
 * never matched what /faces/existing-regions computes for the same
 * region, and that region was endlessly re-offered for backfill on every
 * "Recognize Faces" run instead of being recognised as already done.
 * Fixed here by rebuilding source_region_id from the row's own (always
 * correct) source_image_id plus the '#region-N' suffix already on it —
 * a no-op for every row already in the right form (root-crate images,
 * anything backfilled rather than confirmed, and stranger references,
 * which have no source_region_id at all).
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @returns {number} how many rows were fixed
 */
export function repairMismatchedSourceRegionIds(driver) {
  const rows = driver.all('SELECT id, source_image_id, source_region_id FROM reference_faces');
  let fixed = 0;
  for (const row of rows) {
    if (!row.source_region_id || row.source_region_id.startsWith(row.source_image_id)) continue;
    const hashIndex = row.source_region_id.lastIndexOf('#');
    if (hashIndex === -1) continue;
    const correctedId = row.source_image_id + row.source_region_id.slice(hashIndex);
    driver.run('UPDATE reference_faces SET source_region_id = ? WHERE id = ?', [correctedId, row.id]);
    fixed += 1;
  }
  return fixed;
}

/**
 * One-off data repair, safe to run on every startup: removes duplicate
 * reference_faces rows left over from before hasReferenceForPersonOnImage
 * replaced the old, fragile source_region_id-based "already backfilled?"
 * check — every prior run that failed to recognise a face as already
 * backfilled (see repairMismatchedSourceRegionIds's own history) added
 * another reference for it instead of skipping it, so the same (image,
 * Person, model) combination can have accumulated several redundant
 * rows. Keeps one arbitrary row per combination and deletes the rest;
 * never touches a stranger reference (person_id NULL), since those are
 * not keyed on a Person at all.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @returns {number} how many rows were removed
 */
export function deduplicateReferenceFaces(driver) {
  const before = driver.get('SELECT COUNT(*) as count FROM reference_faces WHERE person_id IS NOT NULL').count;
  driver.run(`
    DELETE FROM reference_faces
    WHERE person_id IS NOT NULL
    AND id NOT IN (
      SELECT MIN(id) FROM reference_faces
      WHERE person_id IS NOT NULL
      GROUP BY source_image_id, person_id, model_name, model_version
    )
  `);
  const after = driver.get('SELECT COUNT(*) as count FROM reference_faces WHERE person_id IS NOT NULL').count;
  return before - after;
}

/**
 * Whether `imageId` has already been face-scanned at its current mtime
 * with the current model — used to skip images a "Find Faces" pass has
 * already covered, the same mtime-skip philosophy already used for EXIF
 * extraction and thumbnails. A model upgrade (different modelVersion) or
 * a changed file (different mtime) both fail this check, so either one
 * causes the image to be scanned again.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} imageId
 * @param {number} fileMtime
 * @param {string} modelName
 * @param {string} modelVersion
 * @returns {boolean}
 */
export function isImageAlreadyScanned(driver, imageId, fileMtime, modelName, modelVersion) {
  const row = driver.get('SELECT * FROM scanned_images WHERE image_id = ?', [imageId]);
  if (!row) return false;
  return row.file_mtime === fileMtime && row.model_name === modelName && row.model_version === modelVersion;
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {{imageId: string, fileMtime: number, modelName: string, modelVersion: string}} options
 */
export function markImageScanned(driver, { imageId, fileMtime, modelName, modelVersion }) {
  const now = new Date().toISOString();
  driver.run(
    `INSERT INTO scanned_images (image_id, file_mtime, model_name, model_version, scanned_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       file_mtime = excluded.file_mtime, model_name = excluded.model_name,
       model_version = excluded.model_version, scanned_at = excluded.scanned_at`,
    [imageId, fileMtime, modelName, modelVersion, now],
  );
}

/**
 * Whether this image can be skipped entirely on this "Recognize Faces"
 * backfill pass — every named region it had was already fully
 * backfilled as of this exact file mtime, so there is nothing left to
 * check without even reading its crate. A changed mtime (the file was
 * edited — including by this app's own /faces/confirm) always fails
 * this check, so an image is never skipped based on stale information.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} imageId
 * @param {number} fileMtime
 * @param {string} modelName
 * @param {string} modelVersion
 * @returns {boolean}
 */
export function isBackfillFullyChecked(driver, imageId, fileMtime, modelName, modelVersion) {
  const row = driver.get('SELECT * FROM backfill_checked_images WHERE image_id = ?', [imageId]);
  if (!row) return false;
  return row.file_mtime === fileMtime && row.model_name === modelName && row.model_version === modelVersion;
}

/**
 * Records that every named region on this image already has a
 * reference as of this exact file mtime — see isBackfillFullyChecked.
 * The caller is responsible for only calling this when that is actually
 * true (i.e. nothing on this image was left needing a reference this
 * pass); marking an image done while it still has an unbackfilled
 * region would mean that region is never looked at again.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {{imageId: string, fileMtime: number, modelName: string, modelVersion: string}} options
 */
export function markBackfillFullyChecked(driver, { imageId, fileMtime, modelName, modelVersion }) {
  const now = new Date().toISOString();
  driver.run(
    `INSERT INTO backfill_checked_images (image_id, file_mtime, model_name, model_version, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       file_mtime = excluded.file_mtime, model_name = excluded.model_name,
       model_version = excluded.model_version, checked_at = excluded.checked_at`,
    [imageId, fileMtime, modelName, modelVersion, now],
  );
}

// Mapped to camelCase here (unlike most of this module's other rows,
// returned as raw SQL columns) since this shape is consumed directly by
// faces/matching.js's findClosestReference, which is also used against
// plain object literals in its own tests — one consistent shape either
// way, rather than matching.js needing to know about SQL column naming.
function parseReferenceFaceRow(row) {
  return {
    id: row.id,
    personId: row.person_id,
    personName: row.person_name,
    sourceRegionId: row.source_region_id,
    sourceImageId: row.source_image_id,
    embedding: JSON.parse(row.embedding),
    modelName: row.model_name,
    modelVersion: row.model_version,
  };
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @returns {Array<{id: string, personId: string|null, personName: string|null, sourceRegionId: string, sourceImageId: string, embedding: number[], modelName: string, modelVersion: string}>}
 */
export function listReferenceFaces(driver, modelName, modelVersion) {
  return driver
    .all('SELECT * FROM reference_faces WHERE model_name = ? AND model_version = ?', [modelName, modelVersion])
    .map(parseReferenceFaceRow);
}

/**
 * Whether this Person already has a reference embedding from this
 * specific image (with this model/version) — used to backfill embeddings
 * for already-tagged regions (from digiKam, Lightroom, or an earlier
 * rocphotos confirmation) without adding the same one twice on a
 * repeated backfill pass.
 *
 * Deliberately keyed on (image, person), not on a region's own computed
 * id: a previous version of this check compared exact source_region_id
 * strings, which meant any inconsistency in how that id happened to be
 * built (crate-relative vs. collection-relative — see
 * repairMismatchedSourceRegionIds's own history) silently broke it,
 * making an already-backfilled face look unbackfilled forever and
 * reprocessing it on every run. What actually matters — has this Person
 * already got a reference from this photo — does not depend on region
 * indices or path forms at all, so it cannot have that class of bug.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} sourceImageId
 * @param {string} personId
 * @param {string} modelName
 * @param {string} modelVersion
 * @returns {boolean}
 */
export function hasReferenceForPersonOnImage(driver, sourceImageId, personId, modelName, modelVersion) {
  const row = driver.get(
    'SELECT 1 FROM reference_faces WHERE source_image_id = ? AND person_id = ? AND model_name = ? AND model_version = ?',
    [sourceImageId, personId, modelName, modelVersion],
  );
  return !!row;
}

/**
 * Whether this already-tagged region has already been tried and given up
 * on (see markRegionUndetectable) with this exact model/version — treated
 * the same as hasReferenceForPersonOnImage for the purpose of deciding
 * whether an image still needs backfilling, so a region that genuinely
 * cannot be re-detected does not get retried (and its image re-examined)
 * on every single "Recognize Faces" run.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} sourceImageId
 * @param {string} personId
 * @param {string} modelName
 * @param {string} modelVersion
 * @returns {boolean}
 */
export function isRegionUndetectable(driver, sourceImageId, personId, modelName, modelVersion) {
  const row = driver.get(
    'SELECT 1 FROM backfill_undetectable_regions WHERE image_id = ? AND person_id = ? AND model_name = ? AND model_version = ?',
    [sourceImageId, personId, modelName, modelVersion],
  );
  return !!row;
}

/**
 * Records that this already-tagged region was genuinely attempted (both
 * a whole-image detection and the zoomed, low-confidence crop fallback —
 * see webview/app.js's computeEmbeddingForKnownRegion) and no embedding
 * could be computed for it — see backfill_undetectable_regions in
 * schema.js for why this is safe to treat as permanent until the model
 * changes.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {{imageId: string, personId: string, personName: string, modelName: string, modelVersion: string}} options
 */
export function markRegionUndetectable(driver, { imageId, personId, personName, modelName, modelVersion }) {
  driver.run(
    `INSERT INTO backfill_undetectable_regions (image_id, person_id, person_name, model_name, model_version, marked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(image_id, person_id, model_name, model_version) DO UPDATE SET
       person_name = excluded.person_name, marked_at = excluded.marked_at`,
    [imageId, personId, personName, modelName, modelVersion, new Date().toISOString()],
  );
}

/**
 * Every region marked undetectable for this model/version — lets a
 * reviewer see exactly which (photo, person) pairs "Recognize Faces" has
 * given up on, e.g. by querying faces-index.sqlite directly (see
 * Spec.md's Face Recognition section).
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} modelName
 * @param {string} modelVersion
 * @returns {Array<{imageId: string, personId: string, personName: string, markedAt: string}>}
 */
export function listUndetectableRegions(driver, modelName, modelVersion) {
  return driver
    .all('SELECT * FROM backfill_undetectable_regions WHERE model_name = ? AND model_version = ?', [modelName, modelVersion])
    .map((row) => ({ imageId: row.image_id, personId: row.person_id, personName: row.person_name, markedAt: row.marked_at }));
}

/**
 * Adds a reference example: either a confirmed sighting of a named Person
 * (personId/personName set) or a permanently-ignored "stranger" (both
 * null) — see Spec.md's Face Recognition section. Always tied to the real
 * ImageRegion it came from, never a bare vector.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} options
 * @param {string} options.id
 * @param {string|null} options.personId
 * @param {string|null} options.personName
 * @param {string} options.sourceRegionId
 * @param {string} options.sourceImageId
 * @param {number[]} options.embedding
 * @param {string} options.modelName
 * @param {string} options.modelVersion
 */
export function addReferenceFace(driver, {
  id, personId, personName, sourceRegionId, sourceImageId, embedding, modelName, modelVersion,
}) {
  driver.run(
    `INSERT INTO reference_faces (id, person_id, person_name, source_region_id, source_image_id, embedding, model_name, model_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, personId, personName, sourceRegionId, sourceImageId, JSON.stringify(embedding), modelName, modelVersion, new Date().toISOString()],
  );
}

function parseDetectionRow(row) {
  return { ...row, embedding: JSON.parse(row.embedding), rejectedPersonIds: JSON.parse(row.rejected_person_ids ?? '[]') };
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} options
 */
export function addDetection(driver, {
  id, imageId, box, embedding, suggestedPersonId = null, suggestedPersonName = null, suggestedDistance = null,
  status = 'pending', modelName, modelVersion,
}) {
  driver.run(
    `INSERT INTO detections (
       id, image_id, box_x, box_y, box_w, box_h, embedding,
       suggested_person_id, suggested_person_name, suggested_distance,
       status, model_name, model_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, imageId, box.x, box.y, box.w, box.h, JSON.stringify(embedding),
      suggestedPersonId, suggestedPersonName, suggestedDistance,
      status, modelName, modelVersion, new Date().toISOString(),
    ],
  );
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} id
 */
export function getDetection(driver, id) {
  const row = driver.get('SELECT * FROM detections WHERE id = ?', [id]);
  return row ? parseDetectionRow(row) : null;
}

/**
 * Detections matching a filter, most recent first. `imageIds`, when
 * given, scopes the result to that set — used to review a single
 * directory's batch (the caller resolves which image ids belong to a
 * collection via the main index's own memberOf filter; the faces index is
 * a separate SQLite file with no notion of collections of its own).
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {{status?: string, imageIds?: string[]}} [filter]
 */
export function listDetections(driver, { status = null, imageIds = null } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (imageIds) {
    if (imageIds.length === 0) return [];
    clauses.push(`image_id IN (${imageIds.map(() => '?').join(',')})`);
    params.push(...imageIds);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return driver.all(`SELECT * FROM detections ${where} ORDER BY created_at ASC`, params).map(parseDetectionRow);
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} id
 * @param {{status: string, resolvedPersonId?: string|null, resolvedPersonName?: string|null}} update
 */
export function updateDetectionStatus(driver, id, { status, resolvedPersonId = null, resolvedPersonName = null }) {
  driver.run(
    'UPDATE detections SET status = ?, resolved_person_id = ?, resolved_person_name = ? WHERE id = ?',
    [status, resolvedPersonId, resolvedPersonName, id],
  );
}

/**
 * Replaces a detection's suggestion, status, and rejected-Person list
 * outright — used by /faces/reject-suggestion after re-matching a
 * detection against the reference set with one more Person excluded.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} id
 * @param {{suggestedPersonId: string|null, suggestedPersonName: string|null, suggestedDistance: number|null, status: string, rejectedPersonIds: string[]}} update
 */
export function updateDetectionSuggestion(driver, id, { suggestedPersonId, suggestedPersonName, suggestedDistance, status, rejectedPersonIds }) {
  driver.run(
    `UPDATE detections SET
       suggested_person_id = ?, suggested_person_name = ?, suggested_distance = ?,
       status = ?, rejected_person_ids = ?
     WHERE id = ?`,
    [suggestedPersonId, suggestedPersonName, suggestedDistance, status, JSON.stringify(rejectedPersonIds), id],
  );
}
