import { SCHEMA_SQL } from './schema.js';
import { joinPath } from '../pathUtils.js';

export const INDEX_FILE_NAME = 'rocphotos-index.sqlite';

// AROCAPI entityType values (see https://github.com/crate-works/ro-crate-api),
// drawn from the PCDM vocabulary: each sub-collection crate is a
// pcdm#Collection, and each image is a pcdm#Object that is a memberOf its
// containing Collection — the aggregation shape AROCAPI's catalog model
// expects, rather than a schema.org type at the entity level.
export const ENTITY_TYPE_COLLECTION = 'http://pcdm.org/models#Collection';
export const ENTITY_TYPE_IMAGE = 'http://pcdm.org/models#Object';

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
 * The inverse of crateEntityId: converts a crate entity id (also used as
 * ro_crates.id and entities.ro_crate_id — see upsertRoCrate/upsertEntity)
 * back to the plain directory path it was built from, for constructing an
 * actual filesystem path. Not meant for display: prefer the entity id
 * form (crateEntityId's output) everywhere a crate is being identified,
 * so that ro_crates.id, entities.ro_crate_id, entities.id (for a crate's
 * own Collection), and entities.member_of all use the one convention and
 * a row can be traced across sheets/tables by matching ids directly,
 * without a blank cell for the root crate.
 *
 * @param {string} crateEntId
 * @returns {string}
 */
export function crateDirPathFromEntityId(crateEntId) {
  return crateEntId === './' ? '' : crateEntId.slice(0, -1);
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
 * The inverse of imageEntityId (and of crateEntityId, for a crate's own
 * Collection entity): converts a collection-relative entity id (as
 * stored in the index, unique across the whole collection) back to the
 * crate-relative id actually used as that entity's `@id` inside its own
 * crate's ro-crate-metadata.json — needed whenever an index row is used
 * to look the entity back up in the real crate file (see
 * bin/rocphotos.js's --include-entity-crates export, and the eventual
 * AROCAPI /entity/{id}/metadata handler). A crate's ids are always
 * relative to itself (e.g. `photo.jpg`, or `./` for its own root
 * Dataset), never prefixed with the crate's own directory path.
 *
 * @param {string} roCrateId - the owning crate's entity id (entities.ro_crate_id / ro_crates.id — see crateEntityId)
 * @param {string} collectionRelativeId - the entity id as stored in the index (entities.id)
 * @returns {string}
 */
export function crateRelativeEntityId(roCrateId, collectionRelativeId) {
  if (collectionRelativeId === roCrateId) {
    return './';
  }
  if (roCrateId === './') {
    return collectionRelativeId;
  }
  return collectionRelativeId.startsWith(roCrateId) ? collectionRelativeId.slice(roCrateId.length) : collectionRelativeId;
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
 * Derives the facet column values (see schema.js: entities.camera,
 * entities.lens, entities.date_created) from a record as returned by
 * addImageEntity or readImageRecord, so both the fresh-processing and
 * the unchanged-file-reuse path in a scan populate them the same way.
 * `camera` combines Make and Model ("Google Pixel 6a"); `lens` prefers
 * LensModel, since it is typically already a full description (e.g.
 * "Pixel 6a back camera 4.38mm f/1.73"), falling back to LensMake alone
 * if that is all that is available.
 *
 * @param {{dateCreated: string|null, exifEntries: Array<{name: string, value: string}>}} record
 * @returns {{dateCreated: string|null, camera: string|null, lens: string|null}}
 */
export function facetValuesFromRecord(record) {
  const exifByName = Object.fromEntries((record.exifEntries ?? []).map((entry) => [entry.name, entry.value]));
  const camera = [exifByName.Make, exifByName.Model].filter(Boolean).join(' ') || null;
  const lens = exifByName.LensModel || exifByName.LensMake || null;
  return { dateCreated: record.dateCreated ?? null, camera, lens };
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
 * @param {string|null} [entity.dateCreated] - see facetValuesFromRecord
 * @param {string|null} [entity.camera]
 * @param {string|null} [entity.lens]
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
  dateCreated = null,
  camera = null,
  lens = null,
}) {
  driver.run(
    `INSERT INTO entities (
       id, ro_crate_id, entity_type, name, description, member_of,
       metadata_license_id, content_license_id, access_metadata, access_content,
       date_created, camera, lens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ro_crate_id = excluded.ro_crate_id,
       entity_type = excluded.entity_type,
       name = excluded.name,
       description = excluded.description,
       member_of = excluded.member_of,
       metadata_license_id = excluded.metadata_license_id,
       content_license_id = excluded.content_license_id,
       access_metadata = excluded.access_metadata,
       access_content = excluded.access_content,
       date_created = excluded.date_created,
       camera = excluded.camera,
       lens = excluded.lens`,
    [
      id, roCrateId, entityType, name, description, memberOf,
      metadataLicenseId, contentLicenseId, accessMetadata ? 1 : 0, accessContent ? 1 : 0,
      dateCreated, camera, lens,
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

/**
 * Every entity whose metadata is recorded in a given RO-Crate (i.e. that
 * crate's own Collection entity, plus every image it directly contains).
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} roCrateId
 */
export function listEntitiesForRoCrate(driver, roCrateId) {
  return driver.all('SELECT * FROM entities WHERE ro_crate_id = ? ORDER BY id', [roCrateId]);
}

/** @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver */
export function getRoCrateById(driver, id) {
  return driver.get('SELECT * FROM ro_crates WHERE id = ?', [id]);
}

/** @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver */
export function listFiles(driver) {
  return driver.all('SELECT * FROM files ORDER BY id');
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} id
 */
export function getEntityById(driver, id) {
  return driver.get('SELECT * FROM entities WHERE id = ?', [id]);
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} id
 */
export function getFileById(driver, id) {
  return driver.get('SELECT * FROM files WHERE id = ?', [id]);
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} entityId
 */
export function listFilesForEntity(driver, entityId) {
  return driver.all('SELECT * FROM files WHERE entity_id = ? ORDER BY id', [entityId]);
}

// The facet dimensions supported for search, per the request scope: camera
// and lens (each a plain column) and year (derived from date_created).
// Kept as an explicit whitelist — never build this SQL fragment from a
// caller-supplied field name directly — since it is interpolated into a
// GROUP BY/SELECT clause rather than bound as a parameter.
const FACET_COLUMNS = {
  camera: 'camera',
  lens: 'lens',
  year: "substr(date_created, 1, 4)",
};

/**
 * Builds a `WHERE ... ` fragment (or '') and its bound parameters from a
 * search filter set. `excludeFacet`, when given, omits that one facet's
 * own filter from the clause — used when counting values for that facet
 * itself, so its counts reflect every other active filter without being
 * collapsed onto whichever single value is already selected for it.
 *
 * @param {object} filters
 * @param {string} [filters.entityType]
 * @param {string} [filters.memberOf]
 * @param {string} [filters.camera]
 * @param {string} [filters.lens]
 * @param {string} [filters.year] - a 4-digit year
 * @param {string} [excludeFacet] - 'camera' | 'lens' | 'year'
 */
function buildSearchWhere(filters, excludeFacet = null) {
  const clauses = [];
  const params = [];

  if (filters.entityType) {
    clauses.push('entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.memberOf) {
    clauses.push('member_of = ?');
    params.push(filters.memberOf);
  }
  if (filters.camera && excludeFacet !== 'camera') {
    clauses.push('camera = ?');
    params.push(filters.camera);
  }
  if (filters.lens && excludeFacet !== 'lens') {
    clauses.push('lens = ?');
    params.push(filters.lens);
  }
  if (filters.year && excludeFacet !== 'year') {
    clauses.push(`${FACET_COLUMNS.year} = ?`);
    params.push(filters.year);
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Entities matching a filter set, most recently dated first.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} [filters] - see buildSearchWhere
 * @param {{limit?: number, offset?: number}} [page]
 */
export function searchEntities(driver, filters = {}, { limit = 100, offset = 0 } = {}) {
  const { where, params } = buildSearchWhere(filters);
  return driver.all(
    `SELECT * FROM entities ${where} ORDER BY date_created DESC, id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

/**
 * The total number of entities matching a filter set (ignoring paging).
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} [filters] - see buildSearchWhere
 */
export function countSearchResults(driver, filters = {}) {
  const { where, params } = buildSearchWhere(filters);
  return driver.get(`SELECT COUNT(*) as count FROM entities ${where}`, params).count;
}

/**
 * Value/count pairs for one facet dimension ('camera', 'lens', or
 * 'year'), most common first, computed against every *other* active
 * filter but not the facet's own (see buildSearchWhere), so selecting a
 * value for a different facet narrows these counts, but a facet never
 * narrows its own counts down to just its currently selected value.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {'camera'|'lens'|'year'} facetName
 * @param {object} [filters] - see buildSearchWhere
 * @returns {Array<{value: string, count: number}>}
 */
export function facetCounts(driver, facetName, filters = {}) {
  const column = FACET_COLUMNS[facetName];
  if (!column) {
    throw new Error(`Unknown facet "${facetName}"`);
  }

  const { where, params } = buildSearchWhere(filters, facetName);
  const notNullClause = `${column} IS NOT NULL`;
  const fullWhere = where ? `${where} AND ${notNullClause}` : `WHERE ${notNullClause}`;

  return driver.all(
    `SELECT ${column} as value, COUNT(*) as count FROM entities ${fullWhere} GROUP BY ${column} ORDER BY count DESC, value ASC`,
    params,
  );
}
