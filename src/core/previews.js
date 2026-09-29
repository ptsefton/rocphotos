import {
  listImagesByPerson,
  listImageIdsByCrate,
  listRoCrates,
  listEntitiesForRoCrate,
  crateDirPathFromEntityId,
  crateRelativeEntityId,
  ENTITY_TYPE_IMAGE,
} from './db/store.js';
import { CRATE_FILE_NAME, loadOrCreateCrate, readImageRecord } from './crateBuilder.js';
import { thumbnailPathFor } from './thumbnails.js';
import { joinPath } from './pathUtils.js';
import {
  PREVIEW_FILE_NAME,
  renderRootCratePreview,
  renderSubCratePreview,
  earliestDate,
} from './htmlPreview.js';

/**
 * Everyone depicted anywhere in the collection, in the shape the root
 * preview page wants (see renderRootCratePreview) — every photo of each
 * person, most recent first, since that page now scrolls a person's set
 * rather than showing a sample of it.
 *
 * Every path is collection-root-relative, which is what the root preview
 * page needs since that is where it sits. A thumbnail path is derived
 * (thumbnailPathFor) rather than read back from each crate: the index
 * does not record it, and reading every crate just for that would undo
 * the point of answering this from the index at all. An image whose
 * processing failed falls back to the full-size file, since a failure
 * there is exactly when the thumbnail may be the thing that is missing.
 *
 * @param {import('../adapters/nodeSqlite.js').SqliteDriver} db
 * @returns {Array<{name: string, total: number, images: Array<{path: string, thumbnailPath: string, name: string, subCollection: string, subCollectionPreview: string, indexInSubCollection: number}>}>}
 */
export function collectPeopleForRootPreview(db) {
  // Where each photo sits on its own sub-collection's page, so a link
  // from here can open it there rather than only opening the page.
  const imageIdsByCrate = listImageIdsByCrate(db);

  return listImagesByPerson(db).map(({ name, images }) => ({
    name,
    total: images.length,
    images: images.map((image) => {
      const crateDirPath = crateDirPathFromEntityId(image.roCrateId);
      const crateRelativePath = crateRelativeEntityId(image.roCrateId, image.id);
      return {
        path: image.id,
        thumbnailPath: image.processingError
          ? image.id
          : joinPath(crateDirPath, thumbnailPathFor(crateRelativePath)),
        name: image.id.split('/').pop(),
        subCollection: crateDirPath || '.',
        subCollectionPreview: joinPath(crateDirPath, PREVIEW_FILE_NAME),
        indexInSubCollection: (imageIdsByCrate.get(image.roCrateId) ?? []).indexOf(image.id),
      };
    }),
  }));
}

// How many crates are in flight at once. The ceiling is the browser's,
// not ours: the File System Access API overlaps requests happily, but a
// higher number mostly queues more work inside the browser process
// while holding more parsed crates in memory at once.
const CRATE_CONCURRENCY = 8;

/**
 * Runs `worker` over `items` with at most `limit` in flight, returning
 * the results in the order of `items` rather than the order they
 * finished. Rejections propagate, as Promise.all does.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/**
 * Whether a failed read means the file is not there, as opposed to
 * something being wrong with it: Node reports ENOENT, the File System
 * Access API a NotFoundError DOMException.
 */
function isNotFound(err) {
  return err?.code === 'ENOENT' || err?.name === 'NotFoundError';
}

/**
 * Rewrites every preview page — each sub-collection's and the root's —
 * from what the index and the crates already say, without re-reading a
 * single photo. Everything a preview shows has been recorded in the
 * crate since the last scan (see readImageRecord), so this is the cheap
 * way to pick up a change to the page template itself, or to see a
 * rename/merge reflected, without the EXIF extraction and thumbnail
 * generation a real rescan would redo.
 *
 * A sub-collection the index knows about but whose crate file has since
 * gone (moved or deleted by hand) is skipped and reported rather than
 * failing the run, the same way a scan treats one it cannot load.
 *
 * @param {object} options
 * @param {import('./fsAdapter.js').FsAdapter} options.fsAdapter
 * @param {import('../adapters/nodeSqlite.js').SqliteDriver} options.db
 * @param {string} options.rootName
 * @param {number} [options.concurrency] how many crates to process at
 *   once; the default suits the browser, and tests use it to pin the
 *   scheduling.
 * @returns {Promise<{written: string[], skipped: Array<{path: string, message: string}>}>}
 */
export async function regeneratePreviews({ fsAdapter, db, rootName, concurrency = CRATE_CONCURRENCY }) {
  const roCrates = listRoCrates(db);

  // Each crate is independent of the others: it reads its own crate
  // file, queries its own rows and writes its own page. Running several
  // at once costs little in Node, where a file operation is cheap, and
  // is what makes this bearable in the browser, where every one is a
  // round trip to the browser process (see browserFs.js) and the run is
  // almost entirely spent waiting on them.
  const outcomes = await mapWithConcurrency(roCrates, concurrency, async (roCrate) => {
    const crateDirPath = crateDirPathFromEntityId(roCrate.id);
    const cratePath = joinPath(crateDirPath, CRATE_FILE_NAME);

    let crate;
    try {
      crate = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(cratePath)));
    } catch (err) {
      // Reading and asking whether it exists first would double the
      // round trips for every crate, so a missing file is recognised
      // from the failure instead.
      const message = isNotFound(err) ? `No ${CRATE_FILE_NAME} on disk any more` : err.message;
      return { skipped: { path: crateDirPath || '.', message } };
    }

    const imageRecords = listEntitiesForRoCrate(db, roCrate.id)
      .filter((entity) => entity.entity_type === ENTITY_TYPE_IMAGE)
      .map((entity) => readImageRecord(crate, crateRelativeEntityId(roCrate.id, entity.id)))
      .filter(Boolean);

    if (crateDirPath === '') {
      // The root directory holding images directly makes it the only
      // crate, and its preview a gallery rather than navigation — the
      // same fork scanning itself makes.
      return { rootImageRecords: imageRecords.length > 0 ? imageRecords : null };
    }

    const depth = crateDirPath.split('/').length;
    const backLink = '../'.repeat(depth) + PREVIEW_FILE_NAME;
    const html = renderSubCratePreview({ name: roCrate.name, images: imageRecords, backLink });
    const previewPath = joinPath(crateDirPath, PREVIEW_FILE_NAME);
    await fsAdapter.writeFile(previewPath, html);

    return {
      written: previewPath,
      summary: { path: crateDirPath, imageCount: imageRecords.length, representativeDate: earliestDate(imageRecords) },
    };
  });

  // Reassembled in the order listRoCrates gave, not the order the
  // workers happened to finish in, so the root page lists its
  // sub-collections the same way however the run was scheduled.
  const written = [];
  const skipped = [];
  const subCrateSummaries = [];
  let rootImageRecords = null;
  for (const outcome of outcomes) {
    if (outcome.skipped) skipped.push(outcome.skipped);
    if (outcome.written) written.push(outcome.written);
    if (outcome.summary) subCrateSummaries.push(outcome.summary);
    if (outcome.rootImageRecords) rootImageRecords = outcome.rootImageRecords;
  }

  const rootHtml = rootImageRecords
    ? renderSubCratePreview({ name: rootName, images: rootImageRecords })
    : renderRootCratePreview({ name: rootName, subCrates: subCrateSummaries, people: collectPeopleForRootPreview(db) });
  await fsAdapter.writeFile(PREVIEW_FILE_NAME, rootHtml);
  written.push(PREVIEW_FILE_NAME);

  return { written, skipped };
}
