import { buildOverview, saveOverview, loadOverview } from '../overview.js';
import { scanCollection } from '../scanCollection.js';
import {
  loadExcludedDirectoryPatterns,
  loadExcludedFilePatterns,
  compileNamePatternMatcher,
  loadWriteMetadataToFilesSetting,
  saveConfig,
} from '../config.js';
import { serializeWrites } from '../writeQueue.js';

function json(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function badRequest(message) {
  return json(400, { error: message });
}

async function excludeMatchers(fsAdapter) {
  return [
    compileNamePatternMatcher(await loadExcludedDirectoryPatterns(fsAdapter)),
    compileNamePatternMatcher(await loadExcludedFilePatterns(fsAdapter)),
  ];
}

async function refreshedOverview(fsAdapter) {
  const [isExcludedDir, isExcludedFile] = await excludeMatchers(fsAdapter);
  const overview = await buildOverview(fsAdapter, isExcludedDir, isExcludedFile);
  await saveOverview(fsAdapter, overview);
  return overview;
}

/**
 * Creates a pure, transport-agnostic handler for the small set of
 * `/admin/*` routes the web view's Scan and Settings screens use.
 *
 * GET/POST /overview and /scan back the "Sub-collections" Scan screen
 * (webview/, and shared — see webview/overviewUI.js — with the browser
 * SPA's own identical screen in index.html/src/main.js), letting a
 * collection be indexed incrementally from a running `rocphotos serve`,
 * the same way the browser SPA already lets a huge, decades-spanning
 * tree be processed a few sub-collections at a time instead of all at
 * once (see Spec.md's collection-overview screen).
 *
 * GET/POST /config back the Settings screen's config.json editor — the
 * only way to change these settings from `rocphotos serve` at all before
 * this (the browser SPA's own Settings section, index.html, has always
 * had a `writeMetadataToFiles` checkbox, but never the exclude-pattern
 * lists either, and none of it ever reached `rocphotos serve`'s own web
 * view). Saved via config.js's own saveConfig, a read-merge-write, so
 * saving one field here never clobbers another the caller did not send.
 * `writeMetadataToFiles` is read once at `rocphotos serve` startup (see
 * bin/rocphotos.js), so a save here needs a server restart to actually
 * take effect — the Settings screen's own UI text says so; this handler
 * does not attempt to hot-reload it.
 *
 * Unlike the browser SPA — where scanning runs client-side, directly
 * against the File System Access API handle the user granted — a
 * server-triggered scan here mutates the same long-lived `db`/`fsAdapter`
 * the rest of `serve` is already using, so a scan's results are visible
 * immediately (the grid, facets, and the admin screen's own status all
 * reflect it right away) without restarting the server. `crateCache` is
 * cleared afterward for the same reason the faces handler's /confirm
 * route updates it — otherwise GET /entity/{id}/metadata would keep
 * serving stale crate data for anything just (re)scanned.
 *
 * @param {object} deps
 * @param {import('../../adapters/nodeSqlite.js').SqliteDriver} deps.db
 * @param {import('../fsAdapter.js').FsAdapter} deps.fsAdapter
 * @param {string} deps.rootName
 * @param {Map<string, import('ro-crate').ROCrate>} [deps.crateCache]
 * @param {(fsAdapter: import('../fsAdapter.js').FsAdapter, crateDirPath: string, imagePath: string, bytes: Uint8Array) => Promise<{thumbnailPath: string|null, error: string|null}>} deps.generateThumbnailFor
 * @returns {(request: {method: string, path: string, query?: object, body?: object}) => Promise<{status: number, headers: object, body: string}>}
 */
export function createAdminHandler({ db, fsAdapter, rootName, crateCache = new Map(), generateThumbnailFor }) {
  return async function handleRequest({ method, path, query = {}, body }) {
    if (method === 'GET' && path === '/overview') {
      // Mirrors the browser SPA's own showOverview: the persisted map
      // (cheap — no directory walk) unless refresh is asked for, or
      // there simply isn't one yet (a collection only ever touched via
      // the CLI, which never writes rocphotos-overview.json).
      const overview = (query.refresh !== 'true' && (await loadOverview(fsAdapter))) || (await refreshedOverview(fsAdapter));
      return json(200, overview);
    }

    if (method === 'POST' && path === '/scan') {
      const subdirs = Array.isArray(body?.subdirs) ? body.subdirs : [];
      if (subdirs.length === 0) {
        return badRequest('subdirs is required (a non-empty array of sub-collection paths to scan)');
      }

      // Serialized the same way the faces handler's /confirm route
      // already is: a scan is itself a read-modify-write of the root
      // crate (and each selected sub-crate) plus a batch of index
      // writes, so two of these — or one of these and a face
      // confirmation — running at once could otherwise interleave and
      // silently lose whichever one's write finishes first.
      return serializeWrites(async () => {
        const result = await scanCollection({ fsAdapter, db, rootName, subdirs, generateThumbnailFor });
        // Cheaper to just drop the whole cache than to work out exactly
        // which crates this scan touched — it is a plain Map, re-populated
        // lazily the next time each one is actually read.
        crateCache?.clear();
        const overview = await refreshedOverview(fsAdapter);
        return json(200, {
          scanned: result.crateDirs.length - result.skippedForSubdir.length - result.failedToLoad.length,
          failedToLoad: result.failedToLoad,
          overview,
        });
      });
    }

    if (method === 'GET' && path === '/config') {
      return json(200, {
        excludeDirectories: await loadExcludedDirectoryPatterns(fsAdapter),
        excludeFiles: await loadExcludedFilePatterns(fsAdapter),
        writeMetadataToFiles: await loadWriteMetadataToFilesSetting(fsAdapter),
      });
    }

    if (method === 'POST' && path === '/config') {
      const updates = {};
      if (Array.isArray(body?.excludeDirectories)) updates.excludeDirectories = body.excludeDirectories;
      if (Array.isArray(body?.excludeFiles)) updates.excludeFiles = body.excludeFiles;
      if (typeof body?.writeMetadataToFiles === 'boolean') updates.writeMetadataToFiles = body.writeMetadataToFiles;
      const updated = await saveConfig(fsAdapter, updates);
      return json(200, {
        excludeDirectories: Array.isArray(updated.excludeDirectories) ? updated.excludeDirectories : await loadExcludedDirectoryPatterns(fsAdapter),
        excludeFiles: Array.isArray(updated.excludeFiles) ? updated.excludeFiles : await loadExcludedFilePatterns(fsAdapter),
        writeMetadataToFiles: updated.writeMetadataToFiles === true,
      });
    }

    return json(404, { error: `No route for ${method} ${path}` });
  };
}
