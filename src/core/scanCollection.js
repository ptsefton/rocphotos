import { walkCollection } from './walker.js';
import { extractExif } from './exif.js';
import { mediaTypeFor } from './imageTypes.js';
import { thumbnailPathFor } from './thumbnails.js';
import { joinPath } from './pathUtils.js';
import {
  CRATE_FILE_NAME,
  loadOrCreateCrate,
  serializeCrate,
  setDatasetName,
  addSubCrateReference,
  addImageEntity,
  recordedModifiedTime,
  readImageRecord,
} from './crateBuilder.js';
import { PREVIEW_FILE_NAME, renderSubCratePreview, renderRootCratePreview, earliestDate } from './htmlPreview.js';
import { CONFIG_FILE_NAME, loadExcludedDirectoryPatterns, loadExcludedFilePatterns, compileNamePatternMatcher } from './config.js';
import {
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
  ENTITY_TYPE_PERSON,
  ENTITY_TYPE_PET,
  crateEntityId,
  imageEntityId,
  personEntityId,
  petEntityId,
  facetValuesFromRecord,
  upsertRoCrate,
  upsertEntity,
  setEntityFacetValues,
  upsertFile,
  listEntitiesForRoCrate,
  getRoCrateById,
} from './db/store.js';

/**
 * Reads an existing sub-collection's ro-crate-metadata.json as text, or
 * null if it does not exist yet — the one bit of crate-loading plumbing
 * every caller of loadOrCreateCrate needs (the CLI, the browser SPA, and
 * now this shared scan core), so it lives here rather than being
 * re-duplicated a third time.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {string} dirPath
 * @returns {Promise<string|null>}
 */
export async function readExistingCrateJson(fsAdapter, dirPath) {
  const cratePath = joinPath(dirPath, CRATE_FILE_NAME);
  if (await fsAdapter.exists(cratePath)) {
    const bytes = await fsAdapter.readFile(cratePath);
    return new TextDecoder().decode(bytes);
  }
  return null;
}

/**
 * Sets up a collection directory that has never been scanned at all —
 * an empty root `ro-crate-metadata.json` and `rocphotos.config.json` (if
 * either is missing) and the root Collection entity's own index row —
 * so `rocphotos serve` can start against a brand new directory and show
 * its admin/overview screen (see src/core/admin/handler.js) without
 * requiring a `rocphotos scan` CLI run first. Idempotent (checks
 * existence before writing anything) and cheap, so a caller can just
 * call it unconditionally on every server start rather than tracking
 * "is this the first run" itself.
 *
 * @param {object} params
 * @param {import('./fsAdapter.js').FsAdapter} params.fsAdapter
 * @param {import('../adapters/nodeSqlite.js').SqliteDriver} params.db
 * @param {string} params.rootName
 */
export async function bootstrapCollection({ fsAdapter, db, rootName }) {
  if (!(await fsAdapter.exists(CRATE_FILE_NAME))) {
    const rootCrate = loadOrCreateCrate(null);
    setDatasetName(rootCrate, rootName);
    await fsAdapter.writeFile(CRATE_FILE_NAME, serializeCrate(rootCrate));
  }
  if (!(await fsAdapter.exists(CONFIG_FILE_NAME))) {
    await fsAdapter.writeFile(CONFIG_FILE_NAME, JSON.stringify({}, null, 2));
  }
  upsertRoCrate(db, { id: crateEntityId(''), path: '.', name: rootName });
  upsertEntity(db, { id: crateEntityId(''), roCrateId: crateEntityId(''), entityType: ENTITY_TYPE_COLLECTION, name: rootName, memberOf: null });
}

/**
 * The actual work of scanning a collection (or, given `subdirs`, just a
 * restricted part of it) into crate files and a SQLite index — the core
 * shared by both `rocphotos scan` (bin/rocphotos.js, which additionally
 * handles --fresh, loose-root-image reconciliation, and console
 * reporting around this) and the running server's own admin
 * scan-on-demand route (src/core/admin/handler.js), so a collection can
 * be indexed incrementally from either the CLI or the web view without
 * two separate implementations of this logic drifting apart.
 *
 * Reuses an already-open `db` and `fsAdapter` rather than constructing
 * its own — the CLI wrapper opens and closes its own short-lived one per
 * invocation; the server passes its own long-lived one, so a scan
 * triggered from the admin screen is reflected immediately in the same
 * process's own index without needing a restart.
 *
 * --subdir semantics (see bin/rocphotos.js's usage text for the full
 * rationale): a sub-collection not selected by `subdirs` (when given) is
 * left entirely untouched — not even read — so an incompatible or
 * corrupt existing crate file anywhere outside the requested subdirs can
 * never block this run; one whose existing crate file fails to load is
 * also left untouched and reported in `failedToLoad`, rather than
 * aborting every other directory too. The root's own directly-contained
 * images are always processed regardless of `subdirs`.
 *
 * @param {object} params
 * @param {import('./fsAdapter.js').FsAdapter} params.fsAdapter
 * @param {import('../adapters/nodeSqlite.js').SqliteDriver} params.db
 * @param {string} params.rootName - the root crate's own display name
 * @param {string[]} [params.subdirs] - restrict processing to these sub-collections (and anything nested under them); empty/omitted means the whole collection
 * @param {boolean} [params.reprocess] - force re-reading every image regardless of modification time (see --reprocess)
 * @param {(fsAdapter: import('./fsAdapter.js').FsAdapter, crateDirPath: string, imagePath: string, bytes: Uint8Array) => Promise<{thumbnailPath: string|null, error: string|null}>} params.generateThumbnailFor - platform-specific (Node vs. browser) thumbnail generation, injected rather than imported directly so this stays usable from either
 * @returns {Promise<{crateDirs: Array<{path: string, images: string[]}>, skippedForSubdir: string[], failedToLoad: Array<{path: string, message: string}>}>}
 */
export async function scanCollection({ fsAdapter, db, rootName, subdirs = [], reprocess = false, generateThumbnailFor }) {
  const isExcludedDir = compileNamePatternMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  const isExcludedFile = compileNamePatternMatcher(await loadExcludedFilePatterns(fsAdapter));

  const { crateDirs } = await walkCollection(fsAdapter, isExcludedDir, isExcludedFile);

  const isSelected = (crateDirPath) =>
    subdirs.length === 0 || subdirs.some((s) => crateDirPath === s || crateDirPath.startsWith(`${s}/`));

  const rootCrateJson = await readExistingCrateJson(fsAdapter, '');
  let rootCrate;
  try {
    rootCrate = loadOrCreateCrate(rootCrateJson);
  } catch (err) {
    throw new Error(`${CRATE_FILE_NAME} is not a valid RO-Crate (${err.message}) — move or remove it before scanning this collection.`);
  }
  setDatasetName(rootCrate, rootName);

  upsertRoCrate(db, { id: crateEntityId(''), path: '.', name: rootName });
  upsertEntity(db, { id: crateEntityId(''), roCrateId: crateEntityId(''), entityType: ENTITY_TYPE_COLLECTION, name: rootName, memberOf: null });

  const subCrateSummaries = [];
  let rootImageRecords = null;
  const skippedForSubdir = [];
  const failedToLoad = [];

  for (const { path: crateDirPath, images } of crateDirs) {
    const isRoot = crateDirPath === '';

    if (!isRoot && !isSelected(crateDirPath)) {
      // Not part of this run — left entirely untouched (not even read),
      // so an incompatible or corrupt crate file elsewhere in the tree
      // never blocks indexing the subdirs actually asked for. Still
      // contributes to the root preview if an earlier run already
      // indexed it; otherwise there is nothing yet to show for it.
      skippedForSubdir.push(crateDirPath);
      const existingRoCrate = getRoCrateById(db, crateEntityId(crateDirPath));
      if (existingRoCrate) {
        const existingImages = listEntitiesForRoCrate(db, crateEntityId(crateDirPath))
          .filter((entity) => entity.entity_type === ENTITY_TYPE_IMAGE);
        subCrateSummaries.push({
          path: crateDirPath,
          imageCount: existingImages.length,
          representativeDate: earliestDate(existingImages.map((entity) => ({ dateCreated: entity.date_created }))),
        });
      }
      continue;
    }

    const subCrateJson = isRoot ? rootCrateJson : await readExistingCrateJson(fsAdapter, crateDirPath);
    let subCrate;
    try {
      subCrate = isRoot ? rootCrate : loadOrCreateCrate(subCrateJson);
    } catch (err) {
      // One incompatible or corrupt existing crate file should not abort
      // indexing everything else — left untouched, exactly like a
      // not-selected directory above, so a later scan (once the file is
      // fixed, moved, or removed) can pick it up normally.
      failedToLoad.push({ path: crateDirPath, message: err.message });
      continue;
    }

    if (!isRoot) {
      addSubCrateReference(rootCrate, crateDirPath);
    }
    const crateName = crateDirPath || rootName;
    setDatasetName(subCrate, crateName);

    if (!isRoot) {
      upsertRoCrate(db, { id: crateEntityId(crateDirPath), path: crateDirPath, name: crateName });
      upsertEntity(db, {
        id: crateEntityId(crateDirPath),
        roCrateId: crateEntityId(crateDirPath),
        entityType: ENTITY_TYPE_COLLECTION,
        name: crateName,
        memberOf: crateEntityId(''),
      });
    }

    const imageRecords = [];
    for (const imagePath of images) {
      const fullImagePath = joinPath(crateDirPath, imagePath);
      const { modifiedTime, size } = await fsAdapter.stat(fullImagePath);
      const recordedTime = recordedModifiedTime(subCrate, imagePath);

      let record;
      if (!reprocess && recordedTime !== null && modifiedTime <= recordedTime) {
        // Unchanged since it was last processed (successfully or not):
        // reuse the existing entity rather than re-reading and
        // re-parsing the file and re-attempting a thumbnail. --reprocess
        // bypasses this, for picking up a change to what scanning itself
        // extracts (a newly-added EXIF field, say) from files that are
        // otherwise unchanged, without needing --fresh to also throw away
        // the root crate and index.
        record = readImageRecord(subCrate, imagePath);
      } else {
        const bytes = await fsAdapter.readFile(fullImagePath);
        const { exif, error: exifError } = await extractExif(bytes);
        const { thumbnailPath, error: thumbnailError } = await generateThumbnailFor(fsAdapter, crateDirPath, imagePath, bytes);
        record = addImageEntity(subCrate, {
          path: imagePath,
          exif,
          exifError,
          thumbnailPath,
          thumbnailError,
          sourceModifiedAt: modifiedTime,
        });
      }
      imageRecords.push(record);

      const entityId = imageEntityId(crateDirPath, imagePath);
      upsertEntity(db, {
        id: entityId,
        roCrateId: crateEntityId(crateDirPath),
        entityType: ENTITY_TYPE_IMAGE,
        name: record.name,
        title: record.title,
        description: record.description,
        processingError: record.processingError,
        memberOf: crateEntityId(crateDirPath),
        dateCreated: record.dateCreated,
      });
      const { camera, lens } = facetValuesFromRecord(record);
      setEntityFacetValues(db, entityId, 'camera', camera ? [camera] : []);
      setEntityFacetValues(db, entityId, 'lens', lens ? [lens] : []);
      setEntityFacetValues(db, entityId, 'keyword', record.keywords);
      setEntityFacetValues(db, entityId, 'rating', record.rating !== null ? [String(record.rating)] : []);
      setEntityFacetValues(db, entityId, 'people', record.people);
      setEntityFacetValues(db, entityId, 'pets', record.pets);
      // A person/pet entity is recorded in the index the first time it is
      // found; upserting on every later sighting (here, and in every other
      // crate that also depicts them) is a no-op beyond that first time,
      // since name is all there currently is to record about them.
      for (const name of record.people) {
        upsertEntity(db, { id: personEntityId(name), roCrateId: crateEntityId(crateDirPath), entityType: ENTITY_TYPE_PERSON, name });
      }
      for (const name of record.pets) {
        upsertEntity(db, { id: petEntityId(name), roCrateId: crateEntityId(crateDirPath), entityType: ENTITY_TYPE_PET, name });
      }
      upsertFile(db, {
        id: entityId,
        entityId,
        filename: record.name,
        mediaType: mediaTypeFor(record.name),
        size,
        relativePath: entityId,
      });
    }

    if (isRoot) {
      // The root directory itself directly contains images: it is both the
      // root crate and the only crate, so its preview is a thumbnail
      // gallery rather than date-based navigation into sub-collections.
      rootImageRecords = imageRecords;
    } else {
      await fsAdapter.writeFile(joinPath(crateDirPath, CRATE_FILE_NAME), serializeCrate(subCrate));

      const depth = crateDirPath.split('/').length;
      const backLink = '../'.repeat(depth) + PREVIEW_FILE_NAME;
      const html = renderSubCratePreview({ name: crateName, images: imageRecords, backLink });
      await fsAdapter.writeFile(joinPath(crateDirPath, PREVIEW_FILE_NAME), html);

      subCrateSummaries.push({ path: crateDirPath, imageCount: images.length, representativeDate: earliestDate(imageRecords) });
    }
  }

  await fsAdapter.writeFile(CRATE_FILE_NAME, serializeCrate(rootCrate));
  const rootHtml = rootImageRecords
    ? renderSubCratePreview({ name: rootName, images: rootImageRecords })
    : renderRootCratePreview({ name: rootName, subCrates: subCrateSummaries });
  await fsAdapter.writeFile(PREVIEW_FILE_NAME, rootHtml);

  return { crateDirs, skippedForSubdir, failedToLoad };
}
