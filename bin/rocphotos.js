#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { generateThumbnail } from '../src/adapters/nodeThumbnail.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { walkCollection, detectLooseRootImages } from '../src/core/walker.js';
import { extractExif } from '../src/core/exif.js';
import { mediaTypeFor } from '../src/core/imageTypes.js';
import { createHandler } from '../src/core/arocapi/handler.js';
import { createFacesHandler } from '../src/core/faces/handler.js';
import { ensureFacesSchema, FACES_INDEX_FILE_NAME } from '../src/core/faces/store.js';
import { writeFaceRegion, isExiftoolAvailable } from '../src/adapters/exiftoolWriteback.js';
import {
  CRATE_FILE_NAME,
  loadOrCreateCrate,
  serializeCrate,
  setDatasetName,
  addSubCrateReference,
  addImageEntity,
  recordedModifiedTime,
  readImageRecord,
  albumMemberIds,
} from '../src/core/crateBuilder.js';
import {
  PREVIEW_FILE_NAME,
  renderSubCratePreview,
  renderRootCratePreview,
  earliestDate,
} from '../src/core/htmlPreview.js';
import { thumbnailPathFor } from '../src/core/thumbnails.js';
import { loadEntityFromCrate } from '../src/core/entityCrate.js';
import {
  loadExcludedDirectoryPatterns,
  loadExcludedFilePatterns,
  compileNamePatternMatcher,
  addExcludedFiles,
  loadWriteMetadataToFilesSetting,
} from '../src/core/config.js';
import {
  INDEX_FILE_NAME,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
  ENTITY_TYPE_PERSON,
  ENTITY_TYPE_PET,
  crateEntityId,
  imageEntityId,
  personEntityId,
  petEntityId,
  facetValuesFromRecord,
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  setEntityFacetValues,
  upsertFile,
  listRoCrates,
  listEntities,
  listFiles,
  getFileById,
  getAlbumById,
  albumEntityId,
} from '../src/core/db/store.js';
import { joinPath } from '../src/core/pathUtils.js';
import { exportDirFor, exportFiles } from '../src/core/export.js';

async function readExistingCrateJson(fsAdapter, dirPath) {
  const cratePath = joinPath(dirPath, CRATE_FILE_NAME);
  if (await fsAdapter.exists(cratePath)) {
    const bytes = await fsAdapter.readFile(cratePath);
    return Buffer.from(bytes).toString('utf8');
  }
  return null;
}

// Attempts to generate a thumbnail from freshly-read image bytes. Only
// called when the source file is already known to need (re)processing
// (see recordedModifiedTime below) — staleness is decided once, up front,
// rather than by checking the thumbnail file's own existence here, so a
// format that fails to thumbnail is not retried on every scan: the error
// is recorded on the image's crate entity (see addImageEntity) and only
// revisited if the source file itself changes.
async function generateThumbnailFor(fsAdapter, crateDirPath, imagePath, bytes) {
  const thumbnailPath = thumbnailPathFor(imagePath);
  try {
    const thumbnailBytes = await generateThumbnail(bytes);
    await fsAdapter.writeFile(joinPath(crateDirPath, thumbnailPath), thumbnailBytes);
    return { thumbnailPath, error: null };
  } catch (err) {
    return { thumbnailPath: null, error: `Thumbnail generation failed: ${err.message}` };
  }
}

// Finds a directory name inside rootDir that doesn't already exist, so
// moving loose root images never collides with something already there.
function findAvailableFolderName(rootDir, baseName) {
  let candidate = baseName;
  let suffix = 2;
  while (fs.existsSync(path.join(rootDir, candidate))) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

// Moves each of `looseImages` (filenames in rootDir) into a new
// subfolder `folderName` (which must not already exist — see
// findAvailableFolderName).
function moveLooseImages(rootDir, looseImages, folderName) {
  fs.mkdirSync(path.join(rootDir, folderName));
  for (const name of looseImages) {
    fs.renameSync(path.join(rootDir, name), path.join(rootDir, folderName, name));
  }
  console.log(`Moved ${looseImages.length} image(s) into ${folderName}/.\n`);
}

/**
 * Detects images sitting loose directly in the collection root (see
 * detectLooseRootImages) and, if any are found, resolves them by either
 * moving them into a new subfolder (so they become a normal
 * sub-collection crate) or recording them in rocphotos.config.json so
 * they are ignored on this and future scans. Left unresolved, they would
 * silently make the whole root a single crate and hide every
 * subdirectory crate beneath it.
 *
 * `options.mode`, if given ('move' or 'ignore'), resolves the situation
 * immediately without prompting — for scripted or repeat use, once the
 * user already knows what they want (see the --loose-root-images CLI
 * flag). Without it, the choice — and, for a move, the destination
 * folder name — is asked for interactively.
 *
 * @param {import('../src/core/fsAdapter.js').FsAdapter} fsAdapter
 * @param {string} rootDir
 * @param {(name: string) => boolean} isExcludedDir
 * @param {(name: string) => boolean} isExcludedFile
 * @param {{mode?: 'move'|'ignore', folderName?: string}} [options]
 */
async function resolveLooseRootImages(fsAdapter, rootDir, isExcludedDir, isExcludedFile, options = {}) {
  const looseImages = await detectLooseRootImages(fsAdapter, isExcludedDir, isExcludedFile);
  if (looseImages.length === 0) {
    return;
  }

  console.log(`\nFound ${looseImages.length} image file(s) directly in the root of this collection, alongside other subdirectories:`);
  for (const name of looseImages) {
    console.log(`  ${name}`);
  }
  console.log('\nLeft as they are, these would make the whole root a single crate and prevent any of the subdirectories below from becoming their own crates.\n');

  if (options.mode === 'move') {
    moveLooseImages(rootDir, looseImages, findAvailableFolderName(rootDir, options.folderName || 'images'));
    return;
  }
  if (options.mode === 'ignore') {
    await addExcludedFiles(fsAdapter, looseImages);
    console.log(`Added ${looseImages.length} filename(s) to excludeFiles in rocphotos.config.json.\n`);
    return;
  }

  if (!process.stdin.isTTY) {
    // Prompting needs a real interactive terminal: readline's sequential
    // questions do not reliably resolve against a piped, non-TTY stdin
    // (a 'close' event can fire mid-way through, once the piped input is
    // exhausted). Fail clearly rather than hanging or silently exiting.
    throw new Error('Not running in an interactive terminal: pass --loose-root-images=move or --loose-root-images=ignore instead of relying on the prompt.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(
      'What would you like to do?\n'
      + '  1) Move them into a new folder\n'
      + '  2) Ignore them (record in rocphotos.config.json)\n'
      + '  3) Do nothing, cancel this scan\n'
      + 'Choice [1/2/3]: ',
    )).trim();

    if (answer === '1') {
      const chosenName = (await rl.question('Folder name [images]: ')).trim() || 'images';
      moveLooseImages(rootDir, looseImages, findAvailableFolderName(rootDir, chosenName));
    } else if (answer === '2') {
      await addExcludedFiles(fsAdapter, looseImages);
      console.log(`Added ${looseImages.length} filename(s) to excludeFiles in rocphotos.config.json.\n`);
    } else {
      throw new Error('Scan cancelled: resolve the loose root images (move or configure them to be ignored), then re-run scan.');
    }
  } finally {
    rl.close();
  }
}

// Deletes the SQLite index and the root crate's own metadata/preview, so
// the next scan rebuilds both entirely from what is currently on disk.
// Needed because both are purely additive today: a hasPart reference (or
// an entities/ro_crates row) for a sub-collection whose directory has
// since been deleted, moved, or renamed is never pruned by an ordinary
// scan, only ever added to. Sub-crate files are left untouched — any
// that still physically exist are picked up normally by the walk that
// follows (including the mtime-skip optimisation within them); any that
// no longer exist simply will not be found by that walk, so they cannot
// end up back in the rebuilt root or index either way.
function resetRootAndIndex(rootDir) {
  const removed = [];
  for (const name of [INDEX_FILE_NAME, CRATE_FILE_NAME, PREVIEW_FILE_NAME]) {
    const fullPath = path.join(rootDir, name);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath);
      removed.push(name);
    }
  }
  if (removed.length > 0) {
    console.log(`--fresh: removed ${removed.join(', ')} from ${rootDir}\n`);
  }
}

async function scan(rootDir, looseRootImagesOptions = {}, { fresh = false, reprocess = false } = {}) {
  if (fresh) {
    resetRootAndIndex(rootDir);
  }

  const fsAdapter = createNodeFsAdapter(rootDir);
  let isExcludedDir = compileNamePatternMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  let isExcludedFile = compileNamePatternMatcher(await loadExcludedFilePatterns(fsAdapter));

  await resolveLooseRootImages(fsAdapter, rootDir, isExcludedDir, isExcludedFile, looseRootImagesOptions);
  // Reload in case resolving just wrote a new excludeFiles entry.
  isExcludedDir = compileNamePatternMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  isExcludedFile = compileNamePatternMatcher(await loadExcludedFilePatterns(fsAdapter));

  const { crateDirs } = await walkCollection(fsAdapter, isExcludedDir, isExcludedFile);

  const rootCrateJson = await readExistingCrateJson(fsAdapter, '');
  const rootCrate = loadOrCreateCrate(rootCrateJson);
  const rootName = path.basename(rootDir);
  setDatasetName(rootCrate, rootName);

  const db = openNodeSqlite(path.join(rootDir, INDEX_FILE_NAME));
  ensureSchema(db);
  // ro_crates.id and entities.ro_crate_id both use the crate entity id
  // convention (crateEntityId: './' for root, '<path>/' for a sub-crate)
  // rather than the raw directory path, so every crate-identifying column
  // — ro_crates.id, entities.ro_crate_id, a crate's own entities.id, and
  // entities.member_of — shares the one value for the same crate, and the
  // root crate never shows as a blank cell. ro_crates.path keeps the real
  // directory path for filesystem purposes, using '.' rather than an
  // empty string for the root, for the same reason.
  upsertRoCrate(db, { id: crateEntityId(''), path: '.', name: rootName });
  upsertEntity(db, { id: crateEntityId(''), roCrateId: crateEntityId(''), entityType: ENTITY_TYPE_COLLECTION, name: rootName, memberOf: null });

  const subCrateSummaries = [];
  let rootImageRecords = null;

  for (const { path: crateDirPath, images } of crateDirs) {
    const isRoot = crateDirPath === '';
    if (!isRoot) {
      addSubCrateReference(rootCrate, crateDirPath);
    }

    const subCrateJson = isRoot ? rootCrateJson : await readExistingCrateJson(fsAdapter, crateDirPath);
    const subCrate = isRoot ? rootCrate : loadOrCreateCrate(subCrateJson);
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

  db.close();

  await fsAdapter.writeFile(CRATE_FILE_NAME, serializeCrate(rootCrate));
  const rootHtml = rootImageRecords
    ? renderSubCratePreview({ name: rootName, images: rootImageRecords })
    : renderRootCratePreview({ name: rootName, subCrates: subCrateSummaries });
  await fsAdapter.writeFile(PREVIEW_FILE_NAME, rootHtml);

  console.log(`Scanned ${crateDirs.length} crate(s) under ${rootDir}`);
  for (const { path: crateDirPath, images } of crateDirs) {
    console.log(`  ${crateDirPath || '(root)'}: ${images.length} image(s)`);
  }
}

async function exportExcel(rootDir, outputPath, { includeEntityCrates = false } = {}) {
  const dbPath = path.join(rootDir, INDEX_FILE_NAME);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No index found at ${dbPath} — run 'rocphotos scan ${rootDir}' first.`);
  }

  const db = openNodeSqlite(dbPath);
  const roCrates = listRoCrates(db);
  const entities = listEntities(db);
  const files = listFiles(db);
  db.close();

  const workbook = new ExcelJS.Workbook();

  const roCratesSheet = workbook.addWorksheet('RO-Crates');
  roCratesSheet.columns = [
    { header: 'id', key: 'id', width: 30 },
    { header: 'path', key: 'path', width: 30 },
    { header: 'name', key: 'name', width: 30 },
    { header: 'created_at', key: 'created_at', width: 24 },
    { header: 'updated_at', key: 'updated_at', width: 24 },
  ];
  roCratesSheet.addRows(roCrates);

  const entitiesSheet = workbook.addWorksheet('Entities');
  entitiesSheet.columns = [
    { header: 'id', key: 'id', width: 44 },
    { header: 'ro_crate_id', key: 'ro_crate_id', width: 20 },
    { header: 'entity_type', key: 'entity_type', width: 34 },
    { header: 'name', key: 'name', width: 30 },
    { header: 'title', key: 'title', width: 30 },
    { header: 'description', key: 'description', width: 40 },
    { header: 'processing_error', key: 'processing_error', width: 40 },
    { header: 'member_of', key: 'member_of', width: 20 },
    { header: 'metadata_license_id', key: 'metadata_license_id', width: 30 },
    { header: 'content_license_id', key: 'content_license_id', width: 30 },
    { header: 'access_metadata', key: 'access_metadata', width: 15 },
    { header: 'access_content', key: 'access_content', width: 14 },
  ];
  entitiesSheet.addRows(entities);

  const filesSheet = workbook.addWorksheet('Files');
  filesSheet.columns = [
    { header: 'id', key: 'id', width: 44 },
    { header: 'entity_id', key: 'entity_id', width: 44 },
    { header: 'filename', key: 'filename', width: 34 },
    { header: 'media_type', key: 'media_type', width: 16 },
    { header: 'size', key: 'size', width: 12 },
    { header: 'relative_path', key: 'relative_path', width: 44 },
    { header: 'access_content', key: 'access_content', width: 14 },
  ];
  filesSheet.addRows(files);

  if (includeEntityCrates) {
    const fsAdapter = createNodeFsAdapter(rootDir);
    const crateCache = new Map();

    const entityCratesSheet = workbook.addWorksheet('Entity Crates');
    entityCratesSheet.columns = [
      { header: 'id', key: 'id', width: 44 },
      { header: 'ro_crate_id', key: 'ro_crate_id', width: 20 },
      { header: 'crate_json', key: 'crate_json', width: 120 },
    ];
    for (const entity of entities) {
      const resolved = await loadEntityFromCrate(fsAdapter, crateCache, entity.ro_crate_id, entity.id);
      entityCratesSheet.addRow({ id: entity.id, ro_crate_id: entity.ro_crate_id, crate_json: resolved ? JSON.stringify(resolved) : null });
    }
  }

  await workbook.xlsx.writeFile(outputPath);
  console.log(`Wrote ${roCrates.length} RO-Crate(s), ${entities.length} entities, ${files.length} files to ${outputPath}`);
}

// A first, deliberately minimal cut of Section 3's Albums export feature
// (see the same route in arocapi/handler.js, which the CLI here mirrors
// rather than calling over HTTP, since this needs no running server) —
// copies each of an album's member files into `_exports/<album>/`,
// preserving each one's own collection-relative path. No crate or other
// metadata is written alongside them yet.
async function exportAlbum(rootDir, albumName) {
  const dbPath = path.join(rootDir, INDEX_FILE_NAME);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No index found at ${dbPath} — run 'rocphotos scan ${rootDir}' first.`);
  }

  const db = openNodeSqlite(dbPath);
  ensureSchema(db);
  const album = getAlbumById(db, albumEntityId(albumName));
  if (!album) {
    db.close();
    throw new Error(`No album named "${albumName}" found in ${rootDir}.`);
  }

  const fsAdapter = createNodeFsAdapter(rootDir);
  const rootCrateJson = await readExistingCrateJson(fsAdapter, '');
  const rootCrate = loadOrCreateCrate(rootCrateJson);
  const memberIds = albumMemberIds(rootCrate, album.id);
  const relativePaths = memberIds.map((id) => getFileById(db, id)?.relative_path).filter(Boolean);
  db.close();

  const destDir = exportDirFor(album.name);
  const { exported, errors } = await exportFiles(fsAdapter, destDir, relativePaths);

  console.log(`Exported ${exported.length} file(s) from "${album.name}" to ${path.join(rootDir, destDir)}`);
  if (errors.length > 0) {
    console.error(`${errors.length} file(s) could not be exported:`);
    for (const { relativePath, message } of errors) {
      console.error(`  ${relativePath}: ${message}`);
    }
  }
}

const WEBVIEW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'webview');
const STATIC_MEDIA_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function serveStaticFile(res, pathname) {
  const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.normalize(path.join(WEBVIEW_DIR, relPath));
  if (!filePath.startsWith(WEBVIEW_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const bytes = await fs.promises.readFile(filePath);
    res.writeHead(200, { 'Content-Type': STATIC_MEDIA_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// Serves the AROCAPI handler under /api/*, and the static web view (see
// webview/) everywhere else, over plain node:http bound to 127.0.0.1
// only — a single-user, local convenience server, never reachable from
// another machine. This is "desktop mode": the same SPA/web view as the
// browser-tab mode, just kept running by a background process instead of
// a one-off dev-server session, opened in a normal Chrome tab.
async function serve(rootDir, { port = 8420 } = {}) {
  const dbPath = path.join(rootDir, INDEX_FILE_NAME);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No index found at ${dbPath} — run 'rocphotos scan ${rootDir}' first.`);
  }

  const fsAdapter = createNodeFsAdapter(rootDir);
  const store = openNodeSqlite(dbPath);
  // Applies any schema additions made since this index was last built or
  // served (new tables/columns — see ensureSchema) to an existing
  // database file, the same way the faces store's own ensureFacesSchema
  // call below already does for it. Without this, `serve` against an
  // index built (or last served) before a schema change would fail the
  // moment anything touched the missing table/column, even though `scan`
  // itself already applies it — confirmed as a real bug: a fresh
  // CREATE TABLE IF NOT EXISTS added for a new feature never actually ran
  // against an already-scanned collection until its next full rescan.
  ensureSchema(store);
  // Shared with the faces handler below (see its own crateCache param):
  // this is the AROCAPI handler's long-lived read cache for GET
  // /entity/{id}/metadata (the viewer's tags and "Show faces" overlay).
  // Without sharing it, a face confirmed via the faces handler would
  // update the crate file and the index correctly, but this process
  // would keep serving whichever version of that crate it last read
  // until restarted.
  const crateCache = new Map();
  const handleRequest = createHandler({ store, fsAdapter, crateCache });

  const facesDbPath = path.join(rootDir, FACES_INDEX_FILE_NAME);
  fs.mkdirSync(path.dirname(facesDbPath), { recursive: true });
  const facesStore = openNodeSqlite(facesDbPath);
  ensureFacesSchema(facesStore);

  const exiftoolAvailable = await isExiftoolAvailable();
  if (!exiftoolAvailable) {
    console.warn('Warning: the `exiftool` binary was not found — confirming a recognized face will not be able to write it back into the photo file.');
  }
  // Read once at startup, the same way exiftoolAvailable is — a change
  // made via the Settings screen while this server is already running
  // takes effect on its next restart, not immediately. Off by default,
  // for a collection with no config file at all (see
  // loadWriteMetadataToFilesSetting in config.js): a --fresh install or
  // one scanned before this setting existed never writes to original
  // files until someone explicitly turns it on.
  const writeBackEnabled = await loadWriteMetadataToFilesSetting(fsAdapter);
  if (exiftoolAvailable && !writeBackEnabled) {
    console.warn('Note: writing recognized faces back into photo files is turned off for this collection (see Settings) — confirming a face will be refused until it is turned on.');
  }
  const handleFacesRequest = createFacesHandler({
    mainStore: store,
    facesStore,
    fsAdapter,
    crateCache,
    // writeFaceRegion (see src/adapters/exiftoolWriteback.js) takes an
    // absolute path; the faces handler only ever knows about paths
    // relative to rootDir (as recorded in files.relative_path), the same
    // as every other fsAdapter-relative path in this app.
    writeFaceRegion: exiftoolAvailable
      ? (relativePath, options) => writeFaceRegion(path.join(rootDir, relativePath), options)
      : null,
    writeBackEnabled,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/faces/')) {
        const query = Object.fromEntries(url.searchParams);
        const body = req.method === 'POST' ? await readJsonBody(req) : null;
        const apiPath = url.pathname.slice('/api/faces'.length) || '/';
        const result = await handleFacesRequest({ method: req.method, path: apiPath, query, body });
        res.writeHead(result.status, result.headers);
        res.end(result.body instanceof Uint8Array ? Buffer.from(result.body) : result.body);
      } else if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
        const query = Object.fromEntries(url.searchParams);
        const body = req.method === 'POST' ? await readJsonBody(req) : null;
        const apiPath = url.pathname.slice(4) || '/';
        const result = await handleRequest({ method: req.method, path: apiPath, query, body });
        res.writeHead(result.status, result.headers);
        res.end(result.body instanceof Uint8Array ? Buffer.from(result.body) : result.body);
      } else if (req.method === 'GET') {
        await serveStaticFile(res, url.pathname);
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Serving ${rootDir}`);
    console.log(`  Web view: http://127.0.0.1:${port}/`);
    console.log(`  API:      http://127.0.0.1:${port}/api/...`);
  });
}

function fail(err) {
  console.error(err.message ?? err);
  process.exit(1);
}

function usage() {
  console.error('Usage: rocphotos scan <directory> [--fresh] [--reprocess] [--loose-root-images=move|ignore] [--loose-root-images-folder=<name>]');
  console.error('       rocphotos export-excel <directory> [output.xlsx] [--include-entity-crates]');
  console.error('       rocphotos export-album <directory> <album name>');
  console.error('       rocphotos serve <directory> [--port=8420]');
  console.error('');
  console.error('serve requires the directory to already have been scanned (it reads the');
  console.error('SQLite index, it does not build it) and binds to 127.0.0.1 only.');
  console.error('');
  console.error('--fresh deletes the SQLite index and the root crate\'s own metadata/preview');
  console.error('before scanning, so stale references to a sub-collection that has since been');
  console.error('deleted, moved, or renamed are not carried forward (they are otherwise only');
  console.error('ever added to, never pruned). Sub-crate files are left alone: anything still');
  console.error('on disk is picked up normally by the scan that follows, including its cached');
  console.error('thumbnails and skip-if-unchanged behaviour.');
  console.error('');
  console.error('--reprocess re-reads and re-extracts every image regardless of whether its');
  console.error('source file has changed since it was last scanned, so a change to what');
  console.error('scanning itself extracts (a newly-added EXIF field, say) is picked up for');
  console.error('every file, not only ones touched since. Unlike --fresh, this does not');
  console.error('discard the index or root crate metadata first. Slower than a normal scan,');
  console.error('since it skips no files.');
  console.error('');
  console.error('--loose-root-images resolves images found loose in the collection root');
  console.error('(alongside other subdirectories) without an interactive prompt: "move"');
  console.error('moves them into a new folder ("images" by default, or --loose-root-images-folder),');
  console.error('"ignore" records them in rocphotos.config.json so they are skipped.');
  console.error('');
  console.error('--include-entity-crates adds an extra sheet with each entity\'s full');
  console.error('RO-Crate JSON-LD document (its "mini crate", per AROCAPI), not just the');
  console.error('flat columns in the Entities sheet. Makes the workbook much larger; meant');
  console.error('for debugging, not routine review.');
  process.exit(1);
}

// Splits argv into positional arguments and --key=value (or bare --key)
// flags, in any order.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) {
        flags[arg.slice(2)] = true;
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, targetDir, extraArg] = positional;

if (command === 'scan' && targetDir) {
  const mode = flags['loose-root-images'];
  if (mode !== undefined && mode !== 'move' && mode !== 'ignore') {
    fail(new Error(`Invalid --loose-root-images value "${mode}" (expected "move" or "ignore")`));
  } else {
    scan(
      path.resolve(targetDir),
      { mode, folderName: flags['loose-root-images-folder'] },
      { fresh: Boolean(flags.fresh), reprocess: Boolean(flags.reprocess) },
    ).catch(fail);
  }
} else if (command === 'export-excel' && targetDir) {
  const resolvedDir = path.resolve(targetDir);
  const outputPath = path.resolve(extraArg || path.join(resolvedDir, 'rocphotos-index.xlsx'));
  exportExcel(resolvedDir, outputPath, { includeEntityCrates: Boolean(flags['include-entity-crates']) }).catch(fail);
} else if (command === 'export-album' && targetDir) {
  // Joined back together rather than using extraArg alone: an album name
  // is free text a user picked, likely containing spaces, unlike every
  // other command's single-word positional argument (a path, a filename).
  const albumName = positional.slice(2).join(' ');
  if (!albumName) {
    fail(new Error('export-album requires an album name: rocphotos export-album <directory> <album name>'));
  } else {
    exportAlbum(path.resolve(targetDir), albumName).catch(fail);
  }
} else if (command === 'serve' && targetDir) {
  const port = flags.port ? Number(flags.port) : 8420;
  serve(path.resolve(targetDir), { port }).catch(fail);
} else {
  usage();
}
