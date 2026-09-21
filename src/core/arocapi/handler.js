import {
  getEntityById,
  getFileById,
  getRoCrateById,
  listFilesForEntity,
  listRoCrates,
  listEntitiesForRoCrate,
  searchEntities,
  countSearchResults,
  facetCounts,
  crateDirPathFromEntityId,
} from '../db/store.js';
import { CRATE_FILE_NAME } from '../crateBuilder.js';
import { loadEntityFromCrate } from '../entityCrate.js';
import { joinPath } from '../pathUtils.js';

// The facets this deployment supports, per the request scope: camera and
// lens (from EXIF) and year (derived from the image's dateCreated).
const SUPPORTED_FACETS = ['camera', 'lens', 'year'];

const CAPABILITIES = {
  apiVersion: '0.1.0-partial',
  deposit: { supported: false },
  tombstonePolicy: '404',
  extensions: {},
  search: { facets: SUPPORTED_FACETS },
};

function json(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function notFound(message = 'Not found') {
  return json(404, { error: message });
}

function badRequest(message) {
  return json(400, { error: message });
}

function entityToJson(row) {
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    description: row.description ?? undefined,
    memberOf: row.member_of ? { id: row.member_of } : undefined,
    metadataLicenseId: row.metadata_license_id,
    contentLicenseId: row.content_license_id,
    access: { metadata: !!row.access_metadata, content: !!row.access_content },
  };
}

function fileToJson(row) {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    access: { content: !!row.access_content },
  };
}

// Filters accepted by both GET /entities (as query params) and POST
// /search (as a `filters` object in the body) — kept in one place so the
// two stay in sync.
function filtersFrom(source) {
  const filters = {};
  for (const key of ['entityType', 'memberOf', 'camera', 'lens', 'year']) {
    if (source[key]) filters[key] = source[key];
  }
  return filters;
}

/**
 * Creates a pure, transport-agnostic AROCAPI request handler (see
 * https://github.com/crate-works/ro-crate-api) over a scanned collection's
 * SQLite index. Read-only: it never writes to a crate's
 * ro-crate-metadata.json or to the index itself. The same handler is used
 * by the Node HTTP server (bin/rocphotos.js's `serve` subcommand) and is
 * intended to also back a Service Worker inside the browser SPA, so that
 * the same web view works identically in both places.
 *
 * Entity, file, and RO-Crate ids may themselves contain '/' (e.g.
 * `2025/03/10/photo.jpg`), so a request path such as `/entity/{id}` or
 * `/entity/{id}/metadata` expects `{id}` to be a single, percent-encoded
 * path segment (`encodeURIComponent`, which also escapes '/'), not a raw
 * multi-segment path.
 *
 * @param {object} deps
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} deps.store
 * @param {import('../fsAdapter.js').FsAdapter} deps.fsAdapter
 * @returns {(request: {method: string, path: string, query?: object, body?: object}) => Promise<{status: number, headers: object, body: string|Uint8Array}>}
 */
export function createHandler({ store, fsAdapter }) {
  const crateCache = new Map();

  async function handleRequest({ method, path, query = {}, body = null }) {
    const parts = path.split('/').filter(Boolean);

    if (method === 'GET' && path === '/capabilities') {
      return json(200, CAPABILITIES);
    }

    if (method === 'GET' && path === '/entities') {
      const filters = filtersFrom(query);
      const limit = Number(query.limit) || 100;
      const offset = Number(query.offset) || 0;
      const rows = searchEntities(store, filters, { limit, offset });
      return json(200, { total: countSearchResults(store, filters), entities: rows.map(entityToJson) });
    }

    if (method === 'POST' && path === '/search') {
      const filters = filtersFrom(body?.filters ?? {});
      const limit = Number(body?.limit) || 100;
      const offset = Number(body?.offset) || 0;
      const requestedFacets = Array.isArray(body?.facets) ? body.facets : [];

      const invalidFacet = requestedFacets.find((name) => !SUPPORTED_FACETS.includes(name));
      if (invalidFacet) {
        return badRequest(`Unsupported facet "${invalidFacet}" (supported: ${SUPPORTED_FACETS.join(', ')})`);
      }

      const rows = searchEntities(store, filters, { limit, offset });
      const facets = {};
      for (const facetName of requestedFacets) {
        facets[facetName] = facetCounts(store, facetName, filters).map((row) => ({ name: row.value, count: row.count }));
      }

      return json(200, { total: countSearchResults(store, filters), entities: rows.map(entityToJson), facets });
    }

    if (method === 'GET' && parts[0] === 'entity' && parts.length === 2) {
      const row = getEntityById(store, decodeURIComponent(parts[1]));
      return row ? json(200, entityToJson(row)) : notFound();
    }

    if (method === 'GET' && parts[0] === 'entity' && parts.length === 3 && parts[2] === 'metadata') {
      const id = decodeURIComponent(parts[1]);
      const row = getEntityById(store, id);
      if (!row) return notFound();
      const resolved = await loadEntityFromCrate(fsAdapter, crateCache, row.ro_crate_id, row.id);
      return resolved ? { status: 200, headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify(resolved) } : notFound();
    }

    // Not part of AROCAPI proper: a thumbnail is not registered in the
    // files table (only the source image is), but its path is derivable
    // from the entity's own crate data (the schema.org `thumbnail`
    // property — see crateBuilder.js), which loadEntityFromCrate already
    // resolves. Needed for the web view to load a small preview instead
    // of the full-size original for every image in a grid.
    if (method === 'GET' && parts[0] === 'entity' && parts.length === 3 && parts[2] === 'thumbnail') {
      const id = decodeURIComponent(parts[1]);
      const row = getEntityById(store, id);
      if (!row) return notFound();
      const resolved = await loadEntityFromCrate(fsAdapter, crateCache, row.ro_crate_id, row.id);
      const thumbnailId = resolved?.thumbnail?.[0]?.['@id'];
      if (!thumbnailId) return notFound('No thumbnail available for this entity');
      const thumbnailPath = joinPath(crateDirPathFromEntityId(row.ro_crate_id), thumbnailId);
      if (!(await fsAdapter.exists(thumbnailPath))) return notFound('Thumbnail file is missing on disk');
      const bytes = await fsAdapter.readFile(thumbnailPath);
      return { status: 200, headers: { 'Content-Type': 'image/jpeg' }, body: bytes };
    }

    if (method === 'GET' && path === '/files') {
      if (!query.entityId) {
        return badRequest('entityId query parameter is required');
      }
      const rows = listFilesForEntity(store, query.entityId);
      return json(200, { total: rows.length, files: rows.map(fileToJson) });
    }

    if (method === 'GET' && parts[0] === 'file' && parts.length === 2) {
      const row = getFileById(store, decodeURIComponent(parts[1]));
      if (!row) return notFound();
      const bytes = await fsAdapter.readFile(row.relative_path);
      return { status: 200, headers: { 'Content-Type': row.media_type || 'application/octet-stream' }, body: bytes };
    }

    if (method === 'GET' && path === '/ro-crates') {
      const rows = listRoCrates(store);
      return json(200, { total: rows.length, roCrates: rows.map((row) => ({ id: row.id, name: row.name })) });
    }

    if (method === 'GET' && parts[0] === 'ro-crate' && parts.length === 2) {
      const id = decodeURIComponent(parts[1]);
      const row = getRoCrateById(store, id);
      if (!row) return notFound();
      const entityIds = listEntitiesForRoCrate(store, id).map((entity) => entity.id);
      return json(200, { id: row.id, name: row.name, entityIds });
    }

    if (method === 'GET' && parts[0] === 'ro-crate' && parts.length === 3 && parts[2] === 'metadata') {
      const id = decodeURIComponent(parts[1]);
      const row = getRoCrateById(store, id);
      if (!row) return notFound();
      const cratePath = joinPath(crateDirPathFromEntityId(id), CRATE_FILE_NAME);
      if (!(await fsAdapter.exists(cratePath))) return notFound();
      const bytes = await fsAdapter.readFile(cratePath);
      return { status: 200, headers: { 'Content-Type': 'application/ld+json' }, body: bytes };
    }

    return notFound(`No route for ${method} ${path}`);
  }

  return handleRequest;
}
