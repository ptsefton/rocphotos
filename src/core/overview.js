import { walkCollection } from './walker.js';
import { CRATE_FILE_NAME, loadOrCreateCrate, recordedModifiedTime } from './crateBuilder.js';
import { joinPath } from './pathUtils.js';

// Persisted at the collection root so re-opening the app finds the map of
// sub-collections again without a full re-walk. Distinct from
// rocphotos.config.json (exclude patterns), which this does not replace.
export const OVERVIEW_FILE_NAME = 'rocphotos-overview.json';

/**
 * A sub-collection's scan status, decided without reading any image's
 * bytes (only a directory walk and a per-image modification-time check —
 * see buildOverview): 'not-scanned' (no ro-crate-metadata.json here yet),
 * 'out-of-date' (a crate exists, but at least one image's file has
 * changed since it was last recorded), or 'up-to-date'.
 *
 * @typedef {'not-scanned'|'out-of-date'|'up-to-date'} ScanStatus
 */

/**
 * Walks the collection and reports each sub-collection's current scan
 * status, cheaply: a directory walk plus one modification-time stat per
 * image, never reading an image's actual bytes or its existing crate's
 * full EXIF data. This is what lets the collection-overview screen show
 * an up-to-date map for a large, decades-spanning tree without paying
 * the real cost of scanning (EXIF extraction and thumbnail generation),
 * which is deferred until the user selects which sub-collections to
 * actually process.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {(name: string) => boolean} [isExcludedDir]
 * @param {(name: string) => boolean} [isExcludedFile]
 * @returns {Promise<{generatedAt: string, subCollections: Array<{path: string, imageCount: number, status: ScanStatus}>}>}
 */
export async function buildOverview(fsAdapter, isExcludedDir, isExcludedFile) {
  const { crateDirs } = await walkCollection(fsAdapter, isExcludedDir, isExcludedFile);
  const subCollections = [];

  for (const { path: crateDirPath, images } of crateDirs) {
    const cratePath = joinPath(crateDirPath, CRATE_FILE_NAME);
    let status = 'not-scanned';

    if (await fsAdapter.exists(cratePath)) {
      const json = new TextDecoder().decode(await fsAdapter.readFile(cratePath));
      const crate = loadOrCreateCrate(json);
      status = 'up-to-date';
      for (const imagePath of images) {
        const { modifiedTime } = await fsAdapter.stat(joinPath(crateDirPath, imagePath));
        const recordedTime = recordedModifiedTime(crate, imagePath);
        if (recordedTime === null || modifiedTime > recordedTime) {
          status = 'out-of-date';
          break;
        }
      }
    }

    subCollections.push({ path: crateDirPath, imageCount: images.length, status });
  }

  return { generatedAt: new Date().toISOString(), subCollections };
}

/**
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {{generatedAt: string, subCollections: Array<object>}} overview
 */
export async function saveOverview(fsAdapter, overview) {
  await fsAdapter.writeFile(OVERVIEW_FILE_NAME, JSON.stringify(overview, null, 2));
}

/**
 * The previously persisted overview, or null if this collection has never
 * had one built (a fresh directory, or one only ever used from the
 * command line, which does not write this file).
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @returns {Promise<{generatedAt: string, subCollections: Array<object>}|null>}
 */
export async function loadOverview(fsAdapter) {
  if (!(await fsAdapter.exists(OVERVIEW_FILE_NAME))) {
    return null;
  }
  const text = new TextDecoder().decode(await fsAdapter.readFile(OVERVIEW_FILE_NAME));
  return JSON.parse(text);
}
