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
  crateRelativeEntityId,
  setEntityFacetValues,
  addEntityFacetValue,
  deleteEntityById,
  getEntityRating,
  upsertEntity,
  crateEntityId,
  createOrUpdateAlbum,
  touchAlbum,
  getAlbumById,
  listAlbums,
} from '../db/store.js';
import {
  CRATE_FILE_NAME,
  loadOrCreateCrate,
  serializeCrate,
  readImageRecord,
  setImageKeywords,
  setImageRating,
  setImageTitle,
  setImageDescription,
  removeImageEntity,
  setAlbumEntity,
  albumMemberIds,
} from '../crateBuilder.js';
import { loadEntityFromCrate, loadRawCrate } from '../entityCrate.js';
import { moveToTrash } from '../trash.js';
import { joinPath } from '../pathUtils.js';
import { serializeWrites } from '../writeQueue.js';

// The facets this deployment supports: camera and lens (from EXIF),
// keyword (from IPTC/XMP, possibly several per image), rating (an XMP
// star rating, 1-5), people and pets (named MWG face/pet regions,
// possibly several per image), albums (Section 3's Albums — populated
// by POST /albums/{id}/add, not derived from the file itself the way
// every other facet here is), and year (derived from the image's
// dateCreated).
const SUPPORTED_FACETS = ['camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'albums', 'year'];

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

// Not an AROCAPI property — included so a list of entities (the grid's
// own view of a search result, in particular) can show each image's
// current star rating without a separate GET .../metadata request per
// tile. Always null for a non-Object entity (a Collection, Person, or
// Pet never has one).
function entityToJson(store, row) {
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    processingError: row.processing_error ?? undefined,
    memberOf: row.member_of ? { id: row.member_of } : undefined,
    metadataLicenseId: row.metadata_license_id,
    contentLicenseId: row.content_license_id,
    access: { metadata: !!row.access_metadata, content: !!row.access_content },
    rating: getEntityRating(store, row.id),
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
  // 'month'/'day' are plain date-part filters, not facets of their own
  // (no sidebar breakdown of counts) — set by the viewer's clickable
  // date breadcrumb alongside 'year', see buildSearchQuery in db/store.js.
  for (const key of ['entityType', 'memberOf', 'camera', 'lens', 'keyword', 'rating', 'people', 'pets', 'albums', 'year', 'month', 'day']) {
    if (source[key]) filters[key] = source[key];
  }
  return filters;
}

// A store passed to createHandler may optionally implement persist(), for
// a driver (such as the browser's sql.js-backed one) that operates on an
// in-memory database and needs an explicit step to write it back to its
// real file after a change — node:sqlite needs no such thing, since it is
// already backed directly by the real file. Called once per edit request,
// after every crate write for it has already happened, never per entity.
async function persistStore(store) {
  await store.persist?.();
}

/**
 * Creates a pure, transport-agnostic request handler combining two
 * things: AROCAPI itself (see https://github.com/crate-works/ro-crate-api)
 * — read-only, it never writes to a crate's ro-crate-metadata.json or to
 * the index — over a scanned collection's SQLite index, and a small set
 * of non-AROCAPI `/edit/*` routes the web view's editing UI uses, which
 * do write to both, the same way scanning itself already does (see
 * Spec.md's Editing section: this is a second writer, not a write path
 * added to AROCAPI's own read endpoints). The same handler is used by the
 * Node HTTP server (bin/rocphotos.js's `serve` subcommand) and by a
 * Service Worker inside the browser SPA, so that the same web view works
 * identically in both places.
 *
 * Entity, file, and RO-Crate ids may themselves contain '/' (e.g.
 * `2025/03/10/photo.jpg`), so a request path such as `/entity/{id}` or
 * `/entity/{id}/metadata` expects `{id}` to be a single, percent-encoded
 * path segment (`encodeURIComponent`, which also escapes '/'), not a raw
 * multi-segment path.
 *
 * @param {object} deps
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver & {persist?: () => Promise<void>}} deps.store
 * @param {import('../fsAdapter.js').FsAdapter} deps.fsAdapter
 * @param {Map<string, import('ro-crate').ROCrate>} [deps.crateCache] - the long-lived read cache below; accepted rather than always created fresh so another writer of the same crate files (see faces/handler.js's /confirm route) can share and keep it in sync too. Defaults to a private one when not given (e.g. in tests, or the browser SW's per-request handler — see src/sw.js).
 * @returns {(request: {method: string, path: string, query?: object, body?: object}) => Promise<{status: number, headers: object, body: string|Uint8Array}>}
 */
export function createHandler({ store, fsAdapter, crateCache = new Map() }) {

  // A short-lived, per-edit-request cache of crates being written to —
  // deliberately not the same long-lived crateCache the read routes
  // above use (see loadEntityFromCrate's own caveat about not sharing a
  // cache across requests/operations): an edit always starts from
  // whatever is on disk right now, and every id in the same request that
  // happens to share a crate reuses that one in-memory copy rather than
  // reading, mutating, and re-serializing it once per id.
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
      // The read routes' crateCache is long-lived (kept for the whole
      // life of this handler, to avoid re-parsing a crate file for every
      // one of its entities — see loadEntityFromCrate), so without this
      // it would keep serving whatever it last read for this crate,
      // silently ignoring the edit just written above. Set directly to
      // the same just-saved object rather than merely evicting the old
      // one, so the very next read reflects the edit without an
      // avoidable extra parse of the file it was just built from.
      crateCache.set(roCrateId, crate);
    }
  }

  // title/description/processingError are plain entities columns, not
  // entity_facets rows (see schema.js) — upsertEntity always needs a
  // full row, so editing just one of them starts from what is already
  // there (an existing entities row, from getEntityById) and overrides
  // only the field(s) actually being edited.
  function upsertEntityFromRow(row, overrides) {
    upsertEntity(store, {
      id: row.id,
      roCrateId: row.ro_crate_id,
      entityType: row.entity_type,
      name: row.name,
      title: row.title,
      description: row.description,
      processingError: row.processing_error,
      memberOf: row.member_of,
      metadataLicenseId: row.metadata_license_id,
      contentLicenseId: row.content_license_id,
      accessMetadata: !!row.access_metadata,
      accessContent: !!row.access_content,
      dateCreated: row.date_created,
      ...overrides,
    });
  }

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
      return json(200, { total: countSearchResults(store, filters), entities: rows.map((row) => entityToJson(store, row)) });
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

      return json(200, { total: countSearchResults(store, filters), entities: rows.map((row) => entityToJson(store, row)), facets });
    }

    if (method === 'GET' && parts[0] === 'entity' && parts.length === 2) {
      const row = getEntityById(store, decodeURIComponent(parts[1]));
      return row ? json(200, entityToJson(store, row)) : notFound();
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

    // The three routes below are not part of AROCAPI — they back the web
    // view's editing UI (see Spec.md's Editing section). Each takes a
    // bulk `ids` array (a single-image edit is just a one-element array)
    // and writes straight to the affected crate file(s) and to the
    // index, the same two places scanning itself writes to, so an edit
    // shows up immediately and survives an ordinary rescan of an
    // otherwise-unchanged file (see setImageKeywords/setImageRating).
    // Each responds with `{updated: [...ids that succeeded], errors:
    // [{id, message}, ...]}` rather than failing the whole request over
    // one bad id in a bulk selection.

    if (method === 'POST' && path === '/edit/keywords') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      const toAdd = Array.isArray(body?.add) ? body.add : [];
      const toRemove = Array.isArray(body?.remove) ? body.remove : [];

      // Serialized against every other crate-writing request (see
      // writeQueue.js) — this and the other /edit/* routes below are the
      // same read-modify-write shape as the faces handler's /confirm,
      // and can race against it or each other the same way.
      return serializeWrites(async () => {
        const cache = new Map();
        const updated = [];
        const errors = [];

        for (const id of ids) {
          const row = getEntityById(store, id);
          if (!row) {
            errors.push({ id, message: 'Not found' });
            continue;
          }
          const crate = await loadCrateForEdit(cache, row.ro_crate_id);
          const crateRelativeId = crateRelativeEntityId(row.ro_crate_id, id);
          const current = readImageRecord(crate, crateRelativeId);
          if (!current) {
            errors.push({ id, message: "Entity not found in its crate's own metadata" });
            continue;
          }
          const keywords = new Set(current.keywords);
          for (const keyword of toAdd) keywords.add(keyword);
          for (const keyword of toRemove) keywords.delete(keyword);
          setImageKeywords(crate, crateRelativeId, [...keywords]);
          setEntityFacetValues(store, id, 'keyword', [...keywords]);
          updated.push(id);
        }

        await saveEditedCrates(cache);
        await persistStore(store);
        return json(200, { updated, errors });
      });
    }

    if (method === 'POST' && path === '/edit/rating') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      const rawRating = body?.rating;
      const rating = rawRating === null || rawRating === undefined ? null : Number(rawRating);
      if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
        return badRequest('rating must be an integer from 1 to 5, or null to clear it');
      }

      return serializeWrites(async () => {
        const cache = new Map();
        const updated = [];
        const errors = [];

        for (const id of ids) {
          const row = getEntityById(store, id);
          if (!row) {
            errors.push({ id, message: 'Not found' });
            continue;
          }
          const crate = await loadCrateForEdit(cache, row.ro_crate_id);
          const crateRelativeId = crateRelativeEntityId(row.ro_crate_id, id);
          setImageRating(crate, crateRelativeId, rating);
          setEntityFacetValues(store, id, 'rating', rating !== null ? [String(rating)] : []);
          updated.push(id);
        }

        await saveEditedCrates(cache);
        await persistStore(store);
        return json(200, { updated, errors });
      });
    }

    if (method === 'POST' && path === '/edit/title') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];

      return serializeWrites(async () => {
        const cache = new Map();
        const updated = [];
        const errors = [];

        for (const id of ids) {
          const row = getEntityById(store, id);
          if (!row) {
            errors.push({ id, message: 'Not found' });
            continue;
          }
          const crate = await loadCrateForEdit(cache, row.ro_crate_id);
          const crateRelativeId = crateRelativeEntityId(row.ro_crate_id, id);
          setImageTitle(crate, crateRelativeId, body?.title);
          // Read back rather than trusting body.title directly: an empty
          // title falls back to the filename (see setImageTitle), and the
          // index should record that resolved value, not a blank one.
          const updatedTitle = readImageRecord(crate, crateRelativeId)?.title ?? row.title;
          upsertEntityFromRow(row, { title: updatedTitle });
          updated.push(id);
        }

        await saveEditedCrates(cache);
        await persistStore(store);
        return json(200, { updated, errors });
      });
    }

    if (method === 'POST' && path === '/edit/description') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      const description = typeof body?.description === 'string' ? body.description.trim() || null : null;

      return serializeWrites(async () => {
        const cache = new Map();
        const updated = [];
        const errors = [];

        for (const id of ids) {
          const row = getEntityById(store, id);
          if (!row) {
            errors.push({ id, message: 'Not found' });
            continue;
          }
          const crate = await loadCrateForEdit(cache, row.ro_crate_id);
          const crateRelativeId = crateRelativeEntityId(row.ro_crate_id, id);
          setImageDescription(crate, crateRelativeId, description);
          upsertEntityFromRow(row, { description });
          updated.push(id);
        }

        await saveEditedCrates(cache);
        await persistStore(store);
        return json(200, { updated, errors });
      });
    }

    if (method === 'POST' && path === '/edit/delete') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];

      return serializeWrites(async () => {
        const cache = new Map();
        const updated = [];
        const errors = [];

        for (const id of ids) {
          const row = getEntityById(store, id);
          if (!row) {
            errors.push({ id, message: 'Not found' });
            continue;
          }
          const fileRow = getFileById(store, id);
          if (!fileRow) {
            errors.push({ id, message: 'No file recorded for this entity' });
            continue;
          }

          // The physical move happens first: if it fails, nothing else
          // about this id is touched, leaving it fully intact rather than
          // looking deleted (gone from the index) while its file is still
          // sitting exactly where it always was.
          try {
            await moveToTrash(fsAdapter, fileRow.relative_path);
          } catch (err) {
            errors.push({ id, message: `Could not move file to trash: ${err.message}` });
            continue;
          }

          const crate = await loadCrateForEdit(cache, row.ro_crate_id);
          const crateRelativeId = crateRelativeEntityId(row.ro_crate_id, id);
          const record = readImageRecord(crate, crateRelativeId);
          if (record?.thumbnailPath) {
            const thumbnailFullPath = joinPath(crateDirPathFromEntityId(row.ro_crate_id), record.thumbnailPath);
            // A missing or already-regenerated thumbnail is not an error
            // worth failing the delete over — the source image is already
            // safely in the trash by this point.
            await fsAdapter.deleteFile(thumbnailFullPath).catch(() => {});
          }
          removeImageEntity(crate, crateRelativeId);
          deleteEntityById(store, id);
          updated.push(id);
        }

        await saveEditedCrates(cache);
        await persistStore(store);
        return json(200, { updated, errors });
      });
    }

    // Albums (Section 3's Albums, Section 2.2's data model) — not part of
    // AROCAPI proper, the same way /edit/* above is not. An album's own
    // entity lives only in the root crate (setAlbumEntity), unlike
    // Person/Pet, which get duplicated into every crate that depicts
    // them: an album is a collection-wide concept with no natural "home"
    // crate of its own to also live in. Membership (an album's `hasPart`)
    // is read and written straight from that root crate entity, not
    // mirrored into a SQL table — see the comment above the Albums
    // functions in db/store.js for why.

    if (method === 'POST' && path === '/albums') {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const description = typeof body?.description === 'string' ? body.description.trim() || null : null;
      if (!name) return badRequest('name is required');

      return serializeWrites(async () => {
        const album = createOrUpdateAlbum(store, { name, description });
        const cache = new Map();
        const rootCrate = await loadCrateForEdit(cache, crateEntityId(''));
        // Preserves whatever members an existing album already had — this
        // route only ever changes name/description, never membership.
        setAlbumEntity(rootCrate, { ...album, memberIds: albumMemberIds(rootCrate, album.id) });
        await saveEditedCrates(cache);
        await persistStore(store);
        return json(200, album);
      });
    }

    if (method === 'GET' && path === '/albums') {
      const albums = listAlbums(store, { query: query.q ?? '' });
      return json(200, { albums });
    }

    if (method === 'GET' && parts[0] === 'albums' && parts.length === 2) {
      const id = decodeURIComponent(parts[1]);
      const album = getAlbumById(store, id);
      if (!album) return notFound();
      // Read-only: uses the same long-lived crateCache as every other GET
      // (see loadRawCrate's own caveat), not the edit-only
      // loadCrateForEdit above, which is for the write routes' own
      // short-lived cache. albumMemberIds needs the raw crate object
      // itself (to follow each hasPart proxy's own prov:specializationOf
      // — see crateBuilder.js), not loadEntityFromCrate's single-entity,
      // one-level-shallow resolution.
      const rootCrate = await loadRawCrate(fsAdapter, crateCache, crateEntityId(''));
      const memberIds = albumMemberIds(rootCrate, id);
      const members = memberIds.map((memberId) => getEntityById(store, memberId)).filter(Boolean).map((row) => entityToJson(store, row));
      return json(200, { ...album, members });
    }

    if (method === 'POST' && parts[0] === 'albums' && parts.length === 3 && parts[2] === 'add') {
      const album = getAlbumById(store, decodeURIComponent(parts[1]));
      if (!album) return notFound();
      const ids = Array.isArray(body?.imageIds) ? body.imageIds : [];

      return serializeWrites(async () => {
        const errors = [];
        const validIds = [];
        for (const id of ids) {
          if (getEntityById(store, id)) validIds.push(id);
          else errors.push({ id, message: 'Not found' });
        }

        const cache = new Map();
        const rootCrate = await loadCrateForEdit(cache, crateEntityId(''));
        const existingMemberIds = albumMemberIds(rootCrate, album.id);
        const existing = new Set(existingMemberIds);
        // Appends after whatever is already there, in the order given —
        // an id already a member (or repeated within this same batch) is
        // left at its existing position, not duplicated or moved to the
        // end.
        const newIds = validIds.filter((id) => {
          if (existing.has(id)) return false;
          existing.add(id);
          return true;
        });
        setAlbumEntity(rootCrate, { ...album, memberIds: [...existingMemberIds, ...newIds] });
        touchAlbum(store, album.id);
        // Makes the album filterable as a facet, composable with every
        // other one (camera, keyword, year, ...) — see the 'albums' entry
        // in STORED_FACETS. Synced for every current member, not only the
        // newly-added ones: addEntityFacetValue only ever adds (an image
        // can be in several albums, so this must never replace its whole
        // set), and is a no-op for a member that already has the row, so
        // this is cheap — but it also means an album whose membership
        // predates this facet existing (or a rescan gap, if one is ever
        // introduced) self-heals the moment anything is next added to it,
        // rather than staying permanently unfilterable.
        for (const imageId of [...existingMemberIds, ...newIds]) {
          addEntityFacetValue(store, imageId, 'albums', album.name);
        }
        await saveEditedCrates(cache);
        await persistStore(store);
        return json(200, { added: newIds.length, errors });
      });
    }

    return notFound(`No route for ${method} ${path}`);
  }

  return handleRequest;
}
