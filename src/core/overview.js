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
 * A folder or crate node in the tree buildOverviewTree returns. A crate
 * (`isCrate: true`) is always a leaf — a crate boundary absorbs
 * everything beneath it, so nothing can be nested inside one — and
 * carries its own status and image count. A plain folder (an
 * intermediate directory above one or more crate boundaries, e.g. a year
 * or month directory that is not itself a crate) has no status of its
 * own; `summary` is the count of its descendant crates in each status,
 * for showing a folder's overall progress without listing every crate
 * beneath it.
 *
 * @typedef {object} OverviewNode
 * @property {string} name - this node's own path segment (e.g. "2024"), or '' for the collection root
 * @property {string} path - full path from the collection root (e.g. "2024/03")
 * @property {boolean} isCrate
 * @property {ScanStatus} [status] - only set when isCrate is true
 * @property {number} [imageCount] - only set when isCrate is true
 * @property {OverviewNode[]} children - empty for a crate
 * @property {{notScanned: number, outOfDate: number, upToDate: number, imageCount: number}} summary - totals over this node and every descendant crate
 */

/**
 * Arranges a flat sub-collection list (as buildOverview/loadOverview
 * produce, and as rocphotos-overview.json persists) into the actual
 * directory tree above each crate boundary — a year, then a month, then
 * a day-crate, say, though the real shape depends entirely on the
 * collection's own layout. The flat list is what gets persisted (simple
 * or diffable); this tree is only ever computed from it in memory, for
 * rendering a collapsible overview that scales to a collection with many
 * hundreds of sub-collections, rather than one unbroken list of all of
 * them at once.
 *
 * @param {Array<{path: string, imageCount: number, status: ScanStatus}>} subCollections
 * @returns {OverviewNode}
 */
export function buildOverviewTree(subCollections) {
  const root = { name: '', path: '', isCrate: false, children: [] };

  for (const sub of [...subCollections].sort((a, b) => a.path.localeCompare(b.path))) {
    if (sub.path === '') {
      // The root directory itself directly contains images: it is both
      // the root crate and the only crate (see the data model), so it
      // has no separate parent folder to nest under.
      root.isCrate = true;
      root.status = sub.status;
      root.imageCount = sub.imageCount;
      continue;
    }

    let node = root;
    let accPath = '';
    for (const part of sub.path.split('/')) {
      accPath = accPath ? `${accPath}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: accPath, isCrate: false, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.isCrate = true;
    node.status = sub.status;
    node.imageCount = sub.imageCount;
  }

  computeOverviewSummaries(root);
  return root;
}

function computeOverviewSummaries(node) {
  if (node.isCrate) {
    node.summary = {
      notScanned: node.status === 'not-scanned' ? 1 : 0,
      outOfDate: node.status === 'out-of-date' ? 1 : 0,
      upToDate: node.status === 'up-to-date' ? 1 : 0,
      imageCount: node.imageCount,
    };
    return node.summary;
  }

  const summary = { notScanned: 0, outOfDate: 0, upToDate: 0, imageCount: 0 };
  for (const child of node.children) {
    const childSummary = computeOverviewSummaries(child);
    summary.notScanned += childSummary.notScanned;
    summary.outOfDate += childSummary.outOfDate;
    summary.upToDate += childSummary.upToDate;
    summary.imageCount += childSummary.imageCount;
  }
  node.summary = summary;
  return summary;
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
