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
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {string} destDir - see exportDirFor
 * @param {string[]} relativePaths - collection-root-relative paths (see files.relative_path in db/store.js)
 * @returns {Promise<{exported: string[], errors: Array<{id: string, message: string}>}>} errors use `id` (holding the relative path) rather than `relativePath`, matching the {id, message} shape every other bulk operation's errors use (see /edit/* in arocapi/handler.js) — the shape the web view's postEdit helper already knows how to format into an error message
 */
export async function exportFiles(fsAdapter, destDir, relativePaths) {
  const exported = [];
  const errors = [];
  for (const relativePath of relativePaths) {
    try {
      const bytes = await fsAdapter.readFile(relativePath);
      await fsAdapter.writeFile(joinPath(destDir, relativePath), bytes);
      exported.push(relativePath);
    } catch (err) {
      errors.push({ id: relativePath, message: err.message });
    }
  }
  return { exported, errors };
}
