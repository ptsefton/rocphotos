import { isImageFile } from './imageTypes.js';
import { joinPath } from './pathUtils.js';
import { THUMBNAILS_DIR_NAME } from './thumbnails.js';

// Applied when no exclusion patterns are supplied (see src/core/config.js),
// and unconditionally on top of whatever the caller does supply: the
// application's own thumbnail cache must never be mistaken for a source of
// images, regardless of user configuration.
const defaultIsExcludedDir = (name) => name.startsWith('.');

// No file is excluded by default (see src/core/config.js for why file
// exclusion, unlike directory exclusion, is opt-in only).
const defaultIsExcludedFile = () => false;

function isSkippedDirectory(name, isExcludedDir) {
  return name === THUMBNAILS_DIR_NAME || isExcludedDir(name);
}

function isCountableImage(name, isExcludedFile) {
  return isImageFile(name) && !isExcludedFile(name);
}

/**
 * Finds sub-collection crate boundaries by walking top-down from `dirPath`.
 * The first directory encountered (including `dirPath` itself) that
 * directly contains a countable image file becomes a crate boundary; the
 * walk does not descend further into it, per the two-level crate depth
 * cap. A file matching `isExcludedFile` is treated as if it were not
 * there, so a handful of stray images sitting loose in an otherwise
 * unremarkable directory cannot themselves force it to become a crate.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fs
 * @param {string} [dirPath]
 * @param {(name: string) => boolean} [isExcludedDir] - directory names to never treat as, or search within for, a crate
 * @param {(name: string) => boolean} [isExcludedFile] - file names to never count as an image
 * @returns {Promise<string[]>} relative paths of crate directories
 */
export async function findCrateDirectories(fs, dirPath = '', isExcludedDir = defaultIsExcludedDir, isExcludedFile = defaultIsExcludedFile) {
  const entries = await fs.readDir(dirPath);
  const hasImage = entries.some((entry) => !entry.isDirectory && isCountableImage(entry.name, isExcludedFile));
  if (hasImage) {
    return [dirPath];
  }

  const crateDirs = [];
  for (const entry of entries) {
    if (entry.isDirectory && !isSkippedDirectory(entry.name, isExcludedDir)) {
      const nested = await findCrateDirectories(fs, joinPath(dirPath, entry.name), isExcludedDir, isExcludedFile);
      crateDirs.push(...nested);
    }
  }
  return crateDirs;
}

/**
 * Recursively collects every countable image file nested under `crateDir`,
 * at any depth, since all such images are absorbed into the same crate.
 * The crate's own `thumbnails/` cache directory, any directory matching
 * `isExcludedDir`, and any file matching `isExcludedFile`, are skipped at
 * every depth.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fs
 * @param {string} crateDir
 * @param {(name: string) => boolean} [isExcludedDir]
 * @param {(name: string) => boolean} [isExcludedFile]
 * @returns {Promise<string[]>} image paths relative to `crateDir`
 */
export async function collectImages(fs, crateDir, isExcludedDir = defaultIsExcludedDir, isExcludedFile = defaultIsExcludedFile) {
  const images = [];

  async function walk(subPath) {
    const entries = await fs.readDir(joinPath(crateDir, subPath));
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (isSkippedDirectory(entry.name, isExcludedDir)) {
          continue;
        }
        await walk(joinPath(subPath, entry.name));
      } else if (isCountableImage(entry.name, isExcludedFile)) {
        images.push(joinPath(subPath, entry.name));
      }
    }
  }

  await walk('');
  return images;
}

/**
 * Detects the one case that silently defeats the two-level crate model:
 * image files sitting loose directly in the root, alongside subdirectories
 * that would otherwise become their own sub-collection crates. Left alone,
 * those loose images would make the root itself the sole crate (per
 * findCrateDirectories's rule) and absorb everything beneath it, so
 * callers are expected to resolve this — by moving the files elsewhere or
 * by excluding them — before walking. Returns an empty array when there
 * is nothing to resolve, including the legitimate case where the root
 * directly holding images is the *only* content (no subdirectories at
 * all): that is the intended single-folder-collection behaviour, not an
 * ambiguity.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fs
 * @param {(name: string) => boolean} [isExcludedDir]
 * @param {(name: string) => boolean} [isExcludedFile]
 * @returns {Promise<string[]>} names of loose image files directly in the root
 */
export async function detectLooseRootImages(fs, isExcludedDir = defaultIsExcludedDir, isExcludedFile = defaultIsExcludedFile) {
  const entries = await fs.readDir('');
  const hasSubdirectories = entries.some((entry) => entry.isDirectory && !isSkippedDirectory(entry.name, isExcludedDir));
  if (!hasSubdirectories) {
    return [];
  }

  return entries
    .filter((entry) => !entry.isDirectory && isCountableImage(entry.name, isExcludedFile))
    .map((entry) => entry.name);
}

/**
 * Walks the whole collection rooted at the granted directory and returns
 * the crate structure: each sub-collection crate directory, with the
 * images it contains.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fs
 * @param {(name: string) => boolean} [isExcludedDir] - directory names to exclude from the walk entirely, in addition to dotfiles and the thumbnail cache
 * @param {(name: string) => boolean} [isExcludedFile] - file names to never count as an image, in addition to being included in a crate
 * @returns {Promise<{crateDirs: Array<{path: string, images: string[]}>}>}
 */
export async function walkCollection(fs, isExcludedDir = defaultIsExcludedDir, isExcludedFile = defaultIsExcludedFile) {
  const crateDirPaths = await findCrateDirectories(fs, '', isExcludedDir, isExcludedFile);
  const crateDirs = [];
  for (const crateDirPath of crateDirPaths) {
    const images = await collectImages(fs, crateDirPath, isExcludedDir, isExcludedFile);
    crateDirs.push({ path: crateDirPath, images });
  }
  return { crateDirs };
}
