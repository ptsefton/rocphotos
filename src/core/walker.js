import { isImageFile } from './imageTypes.js';
import { joinPath } from './pathUtils.js';
import { THUMBNAILS_DIR_NAME } from './thumbnails.js';

// Applied when no exclusion patterns are supplied (see src/core/config.js),
// and unconditionally on top of whatever the caller does supply: the
// application's own thumbnail cache must never be mistaken for a source of
// images, regardless of user configuration.
const defaultIsExcluded = (name) => name.startsWith('.');

function isSkippedDirectory(name, isExcluded) {
  return name === THUMBNAILS_DIR_NAME || isExcluded(name);
}

/**
 * Finds sub-collection crate boundaries by walking top-down from `dirPath`.
 * The first directory encountered (including `dirPath` itself) that
 * directly contains an image file becomes a crate boundary; the walk does
 * not descend further into it, per the two-level crate depth cap.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fs
 * @param {string} [dirPath]
 * @param {(name: string) => boolean} [isExcluded] - directory names to never treat as, or search within for, a crate
 * @returns {Promise<string[]>} relative paths of crate directories
 */
export async function findCrateDirectories(fs, dirPath = '', isExcluded = defaultIsExcluded) {
  const entries = await fs.readDir(dirPath);
  const hasImage = entries.some((entry) => !entry.isDirectory && isImageFile(entry.name));
  if (hasImage) {
    return [dirPath];
  }

  const crateDirs = [];
  for (const entry of entries) {
    if (entry.isDirectory && !isSkippedDirectory(entry.name, isExcluded)) {
      const nested = await findCrateDirectories(fs, joinPath(dirPath, entry.name), isExcluded);
      crateDirs.push(...nested);
    }
  }
  return crateDirs;
}

/**
 * Recursively collects every image file nested under `crateDir`, at any
 * depth, since all such images are absorbed into the same crate. The
 * crate's own `thumbnails/` cache directory, and any directory matching
 * `isExcluded`, are skipped at every depth.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fs
 * @param {string} crateDir
 * @param {(name: string) => boolean} [isExcluded]
 * @returns {Promise<string[]>} image paths relative to `crateDir`
 */
export async function collectImages(fs, crateDir, isExcluded = defaultIsExcluded) {
  const images = [];

  async function walk(subPath) {
    const entries = await fs.readDir(joinPath(crateDir, subPath));
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (isSkippedDirectory(entry.name, isExcluded)) {
          continue;
        }
        await walk(joinPath(subPath, entry.name));
      } else if (isImageFile(entry.name)) {
        images.push(joinPath(subPath, entry.name));
      }
    }
  }

  await walk('');
  return images;
}

/**
 * Walks the whole collection rooted at the granted directory and returns
 * the crate structure: each sub-collection crate directory, with the
 * images it contains.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fs
 * @param {(name: string) => boolean} [isExcluded] - directory names to exclude from the walk entirely, in addition to dotfiles and the thumbnail cache
 * @returns {Promise<{crateDirs: Array<{path: string, images: string[]}>}>}
 */
export async function walkCollection(fs, isExcluded = defaultIsExcluded) {
  const crateDirPaths = await findCrateDirectories(fs, '', isExcluded);
  const crateDirs = [];
  for (const crateDirPath of crateDirPaths) {
    const images = await collectImages(fs, crateDirPath, isExcluded);
    crateDirs.push({ path: crateDirPath, images });
  }
  return { crateDirs };
}
