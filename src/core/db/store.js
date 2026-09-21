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

// A named face/pet region (see regionsFromExif) becomes its own entity,
// rather than only a facet value, so it can be looked up as a first-class
// thing in its own right. Person is a real schema.org type; schema.org
// has no equivalent for a named pet, so Pet is an application-specific
// type, matching how DEFAULT_LICENSE_ID below is also application-minted
// rather than drawn from an external vocabulary.
export const ENTITY_TYPE_PERSON = 'http://schema.org/Person';
export const ENTITY_TYPE_PET = 'urn:rocphotos:type:Pet';

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
 * A stable slug for a person/pet's name, used as the last path segment
 * of its entity id (see personEntityId/petEntityId): letters and digits
 * only, so the exact same name always produces the exact same id across
 * every crate and every rescan, regardless of which photo it was first
 * seen on.
 *
 * @param {string} name
 * @returns {string}
 */
function nameSlug(name) {
  return name.trim().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The entity id for a named face region, identifying that person across
 * the whole collection regardless of which photo(s) tag them. Two
 * different real people who happen to share an exact name are not
 * distinguished (the tagging tool itself has the same limitation, since
 * it also keys face groups by name). An `arcp://` URI is used rather
 * than a path-based id (as crateEntityId/imageEntityId use), since a
 * person is not located at any one place in the collection the way a
 * crate directory or an image file is.
 *
 * @param {string} name
 * @returns {string}
 */
export function personEntityId(name) {
  return `arcp://name,rocphoto/person/${nameSlug(name)}`;
}

/**
 * The entity id for a named pet region — see personEntityId. Pets and
 * people are kept in separate id spaces (`.../pet/` vs `.../person/`)
 * so that a pet and a person who happen to share the same name never
 * collide into a single entity of an ambiguous type.
 *
 * @param {string} name
 * @returns {string}
 */
export function petEntityId(name) {
  return `arcp://name,rocphoto/pet/${nameSlug(name)}`;
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
 * Derives the single-valued facets (camera, lens — see setEntityFacet)
 * from a record as returned by addImageEntity or readImageRecord, so
 * both the fresh-processing and the unchanged-file-reuse path in a scan
 * populate them the same way. `camera` combines Make and Model ("Google
 * Pixel 6a"); `lens` prefers LensModel, since it is typically already a
 * full description ("Pixel 6a back camera 4.38mm f/1.73"), falling back
 * to LensMake alone if that is all that is available.
 *
 * @param {{exifEntries: Array<{name: string, value: string}>}} record
 * @returns {{camera: string|null, lens: string|null}}
 */
export function facetValuesFromRecord(record) {
  const exifByName = Object.fromEntries((record.exifEntries ?? []).map((entry) => [entry.name, entry.value]));
  const camera = [exifByName.Make, exifByName.Model].filter(Boolean).join(' ') || null;
  const lens = exifByName.LensModel || exifByName.LensMake || null;
  return { camera, lens };
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
 * @param {string|null} [entity.dateCreated] - also the basis of the 'year' facet, derived at query time (see facetCounts)
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
}) {
  driver.run(
    `INSERT INTO entities (
       id, ro_crate_id, entity_type, name, description, member_of,
       metadata_license_id, content_license_id, access_metadata, access_content,
       date_created
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       date_created = excluded.date_created`,
    [
      id, roCrateId, entityType, name, description, memberOf,
      metadataLicenseId, contentLicenseId, accessMetadata ? 1 : 0, accessContent ? 1 : 0,
      dateCreated,
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
 * Replaces an entity's full set of values for one facet (see
 * entity_facets in schema.js) with `values`, so a rescan reflects
 * removed as well as added values rather than only ever accumulating
 * rows — unlike the other upsert* functions, which each update one
 * already-identified row, a "list" property like this needs its whole
 * old set cleared first. A no-op (clears any existing rows for this
 * facet, adds none) when `values` is empty; used for single-valued
 * facets (camera, lens — pass a one-element array, or none) exactly the
 * same way as multi-valued ones (keyword).
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} entityId
 * @param {string} facetName
 * @param {string[]} values
 */
export function setEntityFacetValues(driver, entityId, facetName, values) {
  driver.run('DELETE FROM entity_facets WHERE entity_id = ? AND facet_name = ?', [entityId, facetName]);
  for (const value of values) {
    driver.run(
      'INSERT INTO entity_facets (entity_id, facet_name, value) VALUES (?, ?, ?) ON CONFLICT(entity_id, facet_name, value) DO NOTHING',
      [entityId, facetName, value],
    );
  }
}

/**
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {string} entityId
 * @param {string} facetName
 * @returns {string[]}
 */
export function listFacetValuesForEntity(driver, entityId, facetName) {
  return driver
    .all('SELECT value FROM entity_facets WHERE entity_id = ? AND facet_name = ? ORDER BY value', [entityId, facetName])
    .map((row) => row.value);
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

// Facets backed by a row in the generic entity_facets table — every
// facet except 'year', which is derived from entities.date_created at
// query time instead (see facetCounts) rather than being duplicated into
// entity_facets. Kept as an explicit whitelist: facet *names* are always
// interpolated directly into SQL as a quoted literal, never bound as a
// parameter or taken from arbitrary caller input, so every name reaching
// SQL must first be checked against this list.
const STORED_FACETS = ['camera', 'lens', 'keyword', 'rating', 'people', 'pets'];

function assertKnownFacet(facetName) {
  if (facetName !== 'year' && !STORED_FACETS.includes(facetName)) {
    throw new Error(`Unknown facet "${facetName}"`);
  }
}

/**
 * Builds the `JOIN`/`WHERE` fragments and bound parameters for a search
 * filter set. `excludeFacet`, when given, omits that one facet's own
 * filter — used when counting values for that facet itself, so its
 * counts reflect every other active filter without being collapsed onto
 * whichever single value is already selected for it.
 *
 * Every stored facet (see STORED_FACETS) that has an active filter joins
 * entity_facets once, under its own alias (f0, f1, ...), so filtering by
 * more than one facet at once (e.g. a camera and a keyword) works
 * without the joins colliding.
 *
 * @param {object} filters
 * @param {string} [filters.entityType]
 * @param {string} [filters.memberOf]
 * @param {string} [filters.year] - a 4-digit year
 * @param {string} [filters.camera]
 * @param {string} [filters.lens]
 * @param {string} [filters.keyword]
 * @param {string} [excludeFacet] - 'camera' | 'lens' | 'year' | 'keyword'
 */
function buildSearchQuery(filters, excludeFacet = null) {
  const joinParts = [];
  const whereClauses = [];
  const whereParams = [];

  if (filters.entityType) {
    whereClauses.push('e.entity_type = ?');
    whereParams.push(filters.entityType);
  }
  if (filters.memberOf) {
    whereClauses.push('e.member_of = ?');
    whereParams.push(filters.memberOf);
  }
  if (filters.year && excludeFacet !== 'year') {
    whereClauses.push('substr(e.date_created, 1, 4) = ?');
    whereParams.push(filters.year);
  }

  let aliasIndex = 0;
  for (const facetName of STORED_FACETS) {
    if (filters[facetName] && excludeFacet !== facetName) {
      const alias = `f${aliasIndex}`;
      aliasIndex += 1;
      // facetName is always one of STORED_FACETS here, never arbitrary
      // input, so inlining it as a literal is safe and avoids having to
      // interleave join-parameter and where-parameter positions by hand.
      joinParts.push(`JOIN entity_facets ${alias} ON ${alias}.entity_id = e.id AND ${alias}.facet_name = '${facetName}'`);
      whereClauses.push(`${alias}.value = ?`);
      whereParams.push(filters[facetName]);
    }
  }

  return {
    join: joinParts.length > 0 ? ` ${joinParts.join(' ')}` : '',
    where: whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '',
    params: whereParams,
  };
}

/**
 * Entities matching a filter set, most recently dated first.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} [filters] - see buildSearchQuery
 * @param {{limit?: number, offset?: number}} [page]
 */
export function searchEntities(driver, filters = {}, { limit = 100, offset = 0 } = {}) {
  const { join, where, params } = buildSearchQuery(filters);
  return driver.all(
    `SELECT DISTINCT e.* FROM entities e${join} ${where} ORDER BY e.date_created DESC, e.id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

/**
 * The total number of entities matching a filter set (ignoring paging).
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {object} [filters] - see buildSearchQuery
 */
export function countSearchResults(driver, filters = {}) {
  const { join, where, params } = buildSearchQuery(filters);
  return driver.get(`SELECT COUNT(DISTINCT e.id) as count FROM entities e${join} ${where}`, params).count;
}

/**
 * Value/count pairs for one facet dimension ('camera', 'lens', 'year',
 * or 'keyword'), most common first, computed against every *other*
 * active filter but not the facet's own (see buildSearchQuery), so
 * selecting a value for a different facet narrows these counts, but a
 * facet never narrows its own counts down to just its currently selected
 * value.
 *
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} driver
 * @param {'camera'|'lens'|'year'|'keyword'} facetName
 * @param {object} [filters] - see buildSearchQuery
 * @returns {Array<{value: string, count: number}>}
 */
export function facetCounts(driver, facetName, filters = {}) {
  assertKnownFacet(facetName);
  const { join, where, params } = buildSearchQuery(filters, facetName);

  if (facetName === 'year') {
    const column = 'substr(e.date_created, 1, 4)';
    const fullWhere = where ? `${where} AND ${column} IS NOT NULL` : `WHERE ${column} IS NOT NULL`;
    return driver.all(
      `SELECT ${column} as value, COUNT(DISTINCT e.id) as count FROM entities e${join} ${fullWhere} GROUP BY ${column} ORDER BY count DESC, value ASC`,
      params,
    );
  }

  return driver.all(
    `SELECT ef.value as value, COUNT(DISTINCT e.id) as count
     FROM entities e${join} JOIN entity_facets ef ON ef.entity_id = e.id AND ef.facet_name = '${facetName}'
     ${where}
     GROUP BY ef.value ORDER BY count DESC, value ASC`,
    params,
  );
}
