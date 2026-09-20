import { SCHEMA_SQL } from './schema.js';
import { joinPath } from '../pathUtils.js';

export const INDEX_FILE_NAME = 'rocphotos-index.sqlite';

// AROCAPI entityType values (see https://github.com/crate-works/ro-crate-api).
export const ENTITY_TYPE_COLLECTION = 'http://pcdm.org/models#Collection';
export const ENTITY_TYPE_IMAGE = 'http://schema.org/ImageObject';

// AROCAPI's Entity requires metadataLicenseId/contentLicenseId; this app has
// no licensing or access-control model yet (single-user, local-only), so a
// fixed placeholder stands in until a collection sets something else.
export const DEFAULT_LICENSE_ID = 'urn:rocphotos:license:private';

/**
 * The entity id for a crate's own Dataset (the crate directory itself, as
 * a catalog entity), consistent with the RO-Crate root id convention
 * ('./' for the root, a trailing-slash relative path for a sub-crate).
 *
 * @param {string} crateDirPath
 * @returns {string}
 */
export function crateEntityId(crateDirPath) {
  return crateDirPath === '' ? './' : `${crateDirPath}/`;
}

/**
 * The entity id for an image, as a path relative to the whole collection
 * root (not just its own crate directory), so ids are globally unique
 * across every crate in the one index rather than only within their own
 * crate's ro-crate-metadata.json.
 *
 * @param {string} crateDirPath
 * @param {string} imagePath - relative to crateDirPath
 * @returns {string}
 */
export function imageEntityId(crateDirPath, imagePath) {
  return joinPath(crateDirPath, imagePath);
}

/**
 * Creates the index tables if they do not already exist. Safe to call on
 * every scan.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 */
export function ensureSchema(driver) {
  driver.exec(SCHEMA_SQL);
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {{id: string, path: string, name: string}} roCrate
 */
export function upsertRoCrate(driver, { id, path, name }) {
  const now = new Date().toISOString();
  driver.run(
    `INSERT INTO ro_crates (id, path, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    [id, path, name, now, now],
  );
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} entity
 * @param {string} entity.id
 * @param {string} entity.roCrateId
 * @param {string} entity.entityType
 * @param {string} entity.name
 * @param {string|null} [entity.description]
 * @param {string|null} [entity.memberOf]
 * @param {string} [entity.metadataLicenseId]
 * @param {string} [entity.contentLicenseId]
 * @param {boolean} [entity.accessMetadata]
 * @param {boolean} [entity.accessContent]
 */
export function upsertEntity(driver, {
  id,
  roCrateId,
  entityType,
  name,
  description = null,
  memberOf = null,
  metadataLicenseId = DEFAULT_LICENSE_ID,
  contentLicenseId = DEFAULT_LICENSE_ID,
  accessMetadata = true,
  accessContent = true,
}) {
  driver.run(
    `INSERT INTO entities (
       id, ro_crate_id, entity_type, name, description, member_of,
       metadata_license_id, content_license_id, access_metadata, access_content
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ro_crate_id = excluded.ro_crate_id,
       entity_type = excluded.entity_type,
       name = excluded.name,
       description = excluded.description,
       member_of = excluded.member_of,
       metadata_license_id = excluded.metadata_license_id,
       content_license_id = excluded.content_license_id,
       access_metadata = excluded.access_metadata,
       access_content = excluded.access_content`,
    [
      id, roCrateId, entityType, name, description, memberOf,
      metadataLicenseId, contentLicenseId, accessMetadata ? 1 : 0, accessContent ? 1 : 0,
    ],
  );
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} file
 * @param {string} file.id
 * @param {string} file.entityId
 * @param {string} file.filename
 * @param {string} file.mediaType
 * @param {number} file.size
 * @param {string} file.relativePath
 * @param {boolean} [file.accessContent]
 */
export function upsertFile(driver, { id, entityId, filename, mediaType, size, relativePath, accessContent = true }) {
  driver.run(
    `INSERT INTO files (id, entity_id, filename, media_type, size, relative_path, access_content)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       entity_id = excluded.entity_id,
       filename = excluded.filename,
       media_type = excluded.media_type,
       size = excluded.size,
       relative_path = excluded.relative_path,
       access_content = excluded.access_content`,
    [id, entityId, filename, mediaType, size, relativePath, accessContent ? 1 : 0],
  );
}

/** @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver */
export function listRoCrates(driver) {
  return driver.all('SELECT * FROM ro_crates ORDER BY path');
}

/** @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver */
export function listEntities(driver) {
  return driver.all('SELECT * FROM entities ORDER BY id');
}

/** @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver */
export function listFiles(driver) {
  return driver.all('SELECT * FROM files ORDER BY id');
}
