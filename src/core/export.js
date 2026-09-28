import { joinPath } from './pathUtils.js';
import { nameSlug } from './db/store.js';

// A top-level directory (sibling to _rocphotos, not nested under it,
// unlike trash/config/backup): unlike those, an export is meant to be
// found, shared, and moved out of the collection by the user, not just
// internal housekeeping. Excluded from the scan walk (see walker.js)
// the same way _rocphotos already is, so an exported copy is never
// mistaken for a new sub-collection of source images.
export const EXPORTS_DIR_NAME = '_exports';

/**
 * Where one album's exported files go, relative to the collection root
 * — one directory per album, named from the same slug its own entity id
 * already uses (see albumEntityId in db/store.js), so the same album
 * always exports to the same place across repeated exports.
 *
 * @param {string} albumName
 * @returns {string}
 */
export function exportDirFor(albumName) {
  return joinPath(EXPORTS_DIR_NAME, nameSlug(albumName));
}

/**
 * Whether a configured export path (see config.js's
 * loadExportPathSetting) points somewhere outside the collection
 * entirely, rather than being a plain directory name within it. Only a
 * caller able to write outside the collection (the CLI, or `rocphotos
 * serve`, both backed by Node's own unrestricted filesystem access) can
 * honour one of these; the browser-tab SPA's File System Access API
 * handle physically cannot reach outside the granted directory, no
 * matter what path it is handed.
 *
 * @param {string|null} exportPath
 * @returns {boolean}
 */
export function isAbsoluteExportPath(exportPath) {
  return /^(\/|~|[a-zA-Z]:[\\/])/.test(exportPath ?? '');
}

/**
 * Where one album's export should actually be written, given this
 * collection's configured export path (null for the built-in default).
 * Two shapes, since an absolute path is written through a second
 * filesystem adapter rooted at it rather than through the collection's
 * own (see exportFiles):
 *
 * - `{absoluteBase: null, destDir}` — inside the collection, the
 *   built-in `_exports/<album>/`, unchanged from before this setting
 *   existed; `destDir` is collection-root-relative, as every other path
 *   in this app is.
 * - `{absoluteBase, destDir}` — `absoluteBase` is the configured path
 *   itself (still possibly `~`-prefixed; expanding that needs the OS
 *   home directory, so it is left to the Node side — see
 *   bin/rocphotos.js), and `destDir` is just the album's own
 *   subdirectory beneath it. No `_exports/` level: the configured path
 *   *is* the export root, so nesting another one inside it would only
 *   surprise whoever chose it.
 *
 * @param {string} albumName
 * @param {string|null} [exportPath]
 * @returns {{absoluteBase: string|null, destDir: string}}
 */
export function resolveExportTarget(albumName, exportPath = null) {
  if (exportPath && isAbsoluteExportPath(exportPath)) {
    return { absoluteBase: exportPath, destDir: nameSlug(albumName) };
  }
  return { absoluteBase: null, destDir: exportDirFor(albumName) };
}

/**
 * Copies each given file into an export directory, preserving its
 * collection-root-relative path underneath it — a sparse mirror of just
 * these files, nothing else alongside them (no crate, no metadata; see
 * Spec.md's Albums section for what is deliberately not here yet).
 * Overwrites whatever a previous export already left at the same path,
 * so re-exporting an album after adding more photos to it is always
 * safe to just run again. Attempts every file regardless of an earlier
 * one failing, the same way the app's other bulk operations do (see
 * /edit/* in arocapi/handler.js), rather than aborting the whole export
 * over one unreadable file.
 *
 * Reads through the collection's own adapter and writes through a
 * possibly different one: exporting to a configured absolute path (see
 * resolveExportTarget) is just the same copy, with a destination
 * adapter rooted somewhere else entirely. `destFsAdapter` defaults to
 * the source, which is the built-in `_exports/` case.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter - the collection's own adapter, read from
 * @param {string} destDir - see resolveExportTarget, relative to whichever adapter writes
 * @param {string[]} relativePaths - collection-root-relative paths (see files.relative_path in db/store.js)
 * @param {import('./fsAdapter.js').FsAdapter} [destFsAdapter] - written through, when exporting outside the collection
 * @returns {Promise<{exported: string[], errors: Array<{id: string, message: string}>}>} errors use `id` (holding the relative path) rather than `relativePath`, matching the {id, message} shape every other bulk operation's errors use (see /edit/* in arocapi/handler.js) — the shape the web view's postEdit helper already knows how to format into an error message
 */
export async function exportFiles(fsAdapter, destDir, relativePaths, destFsAdapter = fsAdapter) {
  const exported = [];
  const errors = [];
  for (const relativePath of relativePaths) {
    try {
      const bytes = await fsAdapter.readFile(relativePath);
      await destFsAdapter.writeFile(joinPath(destDir, relativePath), bytes);
      exported.push(relativePath);
    } catch (err) {
      errors.push({ id: relativePath, message: err.message });
    }
  }
  return { exported, errors };
}
