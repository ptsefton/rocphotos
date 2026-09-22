import { FACES_SCHEMA_SQL } from './schema.js';
import { FACES_DIR_NAME } from './crate.js';
import { joinPath } from '../pathUtils.js';

export const FACES_INDEX_FILE_NAME = joinPath(FACES_DIR_NAME, 'faces-index.sqlite');

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 */
export function ensureFacesSchema(driver) {
  driver.exec(FACES_SCHEMA_SQL);
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
 * Whether a reference face already exists for this exact source region
 * (with this model/version) — used to backfill embeddings for
 * already-tagged regions (from digiKam, Lightroom, or an earlier
 * rocphotos confirmation) without adding the same one twice on a
 * repeated backfill pass.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} sourceRegionId
 * @param {string} modelName
 * @param {string} modelVersion
 * @returns {boolean}
 */
export function hasReferenceFaceForRegion(driver, sourceRegionId, modelName, modelVersion) {
  const row = driver.get(
    'SELECT 1 FROM reference_faces WHERE source_region_id = ? AND model_name = ? AND model_version = ?',
    [sourceRegionId, modelName, modelVersion],
  );
  return !!row;
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
  return { ...row, embedding: JSON.parse(row.embedding) };
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
