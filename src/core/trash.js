import { joinPath } from './pathUtils.js';

// One directory at the collection root (not one per crate) for the
// application's own housekeeping — currently just trash; config/ and
// backup/ are reserved for later. Excluded from the walk everywhere,
// the same way thumbnails/ is (see walker.js), so a trashed image is
// never mistaken for a source image on a later scan.
export const ROCPHOTOS_DIR_NAME = '_rocphotos';
export const TRASH_DIR_NAME = joinPath(ROCPHOTOS_DIR_NAME, 'trash');

/**
 * Where a deleted file ends up, preserving its original collection-root-
 * relative path underneath the trash directory (not just its filename),
 * so two images of the same name from different sub-collections never
 * collide there.
 *
 * @param {string} relativePath - path relative to the collection root
 * @returns {string}
 */
export function trashPathFor(relativePath) {
  return joinPath(TRASH_DIR_NAME, relativePath);
}

/**
 * Moves a file into the trash rather than deleting it outright. Copies
 * the bytes to their trash location and then removes the original,
 * rather than using a single rename/move call, since the File System
 * Access API has no such primitive — only individual file handles to
 * read, write, and remove.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {string} relativePath - path relative to the collection root
 * @returns {Promise<string>} the path it was moved to
 */
export async function moveToTrash(fsAdapter, relativePath) {
  const destination = trashPathFor(relativePath);
  const bytes = await fsAdapter.readFile(relativePath);
  await fsAdapter.writeFile(destination, bytes);
  await fsAdapter.deleteFile(relativePath);
  return destination;
}
