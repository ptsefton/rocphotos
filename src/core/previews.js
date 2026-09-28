import {
  listImagesByPerson,
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
  ROOT_PERSON_THUMBNAIL_LIMIT,
  renderRootCratePreview,
  renderSubCratePreview,
  earliestDate,
} from './htmlPreview.js';

/**
 * Everyone depicted anywhere in the collection, in the shape the root
 * preview page wants (see renderRootCratePreview) — each person capped
 * at ROOT_PERSON_THUMBNAIL_LIMIT of their most recent photos, with the
 * true total kept so the page can say what it is not showing.
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
 * @returns {Array<{name: string, total: number, images: Array<{path: string, thumbnailPath: string, name: string, subCollection: string}>}>}
 */
export function collectPeopleForRootPreview(db) {
  return listImagesByPerson(db).map(({ name, images }) => ({
    name,
    total: images.length,
    images: images.slice(0, ROOT_PERSON_THUMBNAIL_LIMIT).map((image) => {
      const crateDirPath = crateDirPathFromEntityId(image.roCrateId);
      const crateRelativePath = crateRelativeEntityId(image.roCrateId, image.id);
      return {
        path: image.id,
        thumbnailPath: image.processingError
          ? image.id
          : joinPath(crateDirPath, thumbnailPathFor(crateRelativePath)),
        name: image.id.split('/').pop(),
        subCollection: crateDirPath || '.',
      };
    }),
  }));
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
 * @returns {Promise<{written: string[], skipped: Array<{path: string, message: string}>}>}
 */
export async function regeneratePreviews({ fsAdapter, db, rootName }) {
  const written = [];
  const skipped = [];
  const subCrateSummaries = [];
  let rootImageRecords = null;

  for (const roCrate of listRoCrates(db)) {
    const crateDirPath = crateDirPathFromEntityId(roCrate.id);
    const cratePath = joinPath(crateDirPath, CRATE_FILE_NAME);
    if (!(await fsAdapter.exists(cratePath))) {
      skipped.push({ path: crateDirPath || '.', message: `No ${CRATE_FILE_NAME} on disk any more` });
      continue;
    }

    let crate;
    try {
      crate = loadOrCreateCrate(new TextDecoder().decode(await fsAdapter.readFile(cratePath)));
    } catch (err) {
      skipped.push({ path: crateDirPath || '.', message: err.message });
      continue;
    }

    const imageRecords = listEntitiesForRoCrate(db, roCrate.id)
      .filter((entity) => entity.entity_type === ENTITY_TYPE_IMAGE)
      .map((entity) => readImageRecord(crate, crateRelativeEntityId(roCrate.id, entity.id)))
      .filter(Boolean);

    if (crateDirPath === '') {
      // The root directory holding images directly makes it the only
      // crate, and its preview a gallery rather than navigation — the
      // same fork scanning itself makes.
      if (imageRecords.length > 0) rootImageRecords = imageRecords;
      continue;
    }

    const depth = crateDirPath.split('/').length;
    const backLink = '../'.repeat(depth) + PREVIEW_FILE_NAME;
    const html = renderSubCratePreview({ name: roCrate.name, images: imageRecords, backLink });
    await fsAdapter.writeFile(joinPath(crateDirPath, PREVIEW_FILE_NAME), html);
    written.push(joinPath(crateDirPath, PREVIEW_FILE_NAME));

    subCrateSummaries.push({ path: crateDirPath, imageCount: imageRecords.length, representativeDate: earliestDate(imageRecords) });
  }

  const rootHtml = rootImageRecords
    ? renderSubCratePreview({ name: rootName, images: rootImageRecords })
    : renderRootCratePreview({ name: rootName, subCrates: subCrateSummaries, people: collectPeopleForRootPreview(db) });
  await fsAdapter.writeFile(PREVIEW_FILE_NAME, rootHtml);
  written.push(PREVIEW_FILE_NAME);

  return { written, skipped };
}
