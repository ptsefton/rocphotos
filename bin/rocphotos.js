#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { generateThumbnail } from '../src/adapters/nodeThumbnail.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { detectLooseRootImages } from '../src/core/walker.js';
import { createHandler } from '../src/core/arocapi/handler.js';
import { createAdminHandler } from '../src/core/admin/handler.js';
import { createFacesHandler } from '../src/core/faces/handler.js';
import { createPeopleHandler } from '../src/core/people/handler.js';
import { ensureFacesSchema, FACES_INDEX_FILE_NAME } from '../src/core/faces/store.js';
import { writeFaceRegion, writeImageMetadata, isExiftoolAvailable } from '../src/adapters/exiftoolWriteback.js';
import { CRATE_FILE_NAME, loadOrCreateCrate, albumMemberIds, readImageRecord } from '../src/core/crateBuilder.js';
import { PREVIEW_FILE_NAME } from '../src/core/htmlPreview.js';
import { thumbnailPathFor } from '../src/core/thumbnails.js';
import { loadEntityFromCrate } from '../src/core/entityCrate.js';
import {
  loadExcludedDirectoryPatterns,
  loadExcludedFilePatterns,
  compileNamePatternMatcher,
  addExcludedFiles,
  loadWriteMetadataToFilesSetting,
  loadExportPathSetting,
  loadExportWithMetadataSetting,
} from '../src/core/config.js';
import {
  INDEX_FILE_NAME,
  ensureSchema,
  listRoCrates,
  listEntities,
  listFiles,
  getFileById,
  getEntityById,
  getAlbumById,
  albumEntityId,
  crateRelativeEntityId,
  crateDirPathFromEntityId,
} from '../src/core/db/store.js';
import { joinPath } from '../src/core/pathUtils.js';
import { exportFiles, resolveExportTarget, writeExportMetadata } from '../src/core/export.js';
import { scanCollection, bootstrapCollection, readExistingCrateJson } from '../src/core/scanCollection.js';

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

async function scan(rootDir, looseRootImagesOptions = {}, { fresh = false, reprocess = false, subdirs = [] } = {}) {
  if (fresh) {
    resetRootAndIndex(rootDir);
  }

  const fsAdapter = createNodeFsAdapter(rootDir);
  const isExcludedDir = compileNamePatternMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  const isExcludedFile = compileNamePatternMatcher(await loadExcludedFilePatterns(fsAdapter));
  // scanCollection below reloads exclude patterns itself, fresh, so
  // resolving here (which can rewrite excludeFiles) does not need its own
  // extra reload step before the walk that follows.
  await resolveLooseRootImages(fsAdapter, rootDir, isExcludedDir, isExcludedFile, looseRootImagesOptions);

  const db = openNodeSqlite(path.join(rootDir, INDEX_FILE_NAME));
  ensureSchema(db);
  const rootName = path.basename(rootDir);

  let result;
  try {
    result = await scanCollection({ fsAdapter, db, rootName, subdirs, reprocess, generateThumbnailFor });
  } finally {
    db.close();
  }

  const { crateDirs, skippedForSubdir, failedToLoad } = result;
  for (const { path: crateDirPath, message } of failedToLoad) {
    console.error(`Skipping ${crateDirPath}: ${joinPath(crateDirPath, CRATE_FILE_NAME)} is not a valid RO-Crate (${message}) — move or remove it, then re-scan this directory.`);
  }

  const processedCount = crateDirs.length - skippedForSubdir.length - failedToLoad.length;
  console.log(`Scanned ${processedCount} crate(s) under ${rootDir}`);
  for (const { path: crateDirPath, images } of crateDirs) {
    if (skippedForSubdir.includes(crateDirPath) || failedToLoad.some((f) => f.path === crateDirPath)) continue;
    console.log(`  ${crateDirPath || '(root)'}: ${images.length} image(s)`);
  }
  if (skippedForSubdir.length > 0) {
    console.log(`Left untouched, not selected by --subdir: ${skippedForSubdir.join(', ')}`);
  }
  if (failedToLoad.length > 0) {
    console.log(`Skipped, existing crate file could not be read (see errors above): ${failedToLoad.map((f) => f.path).join(', ')}`);
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

// Builds an FsAdapter rooted anywhere on disk, for an export path
// configured outside the collection (Settings' "Export path" — see
// config.js's loadExportPathSetting). `~` is expanded here rather than
// in core: only Node knows the OS home directory, and core stays
// runnable unmodified in the browser, which has no such concept (nor
// any way to reach an absolute path at all). Relative to the
// collection root if the configured path somehow is not absolute
// after all, so this can never silently write to the process's own
// working directory.
function resolveConfiguredExportPath(rootDir, configuredPath) {
  const expanded = configuredPath.startsWith('~')
    ? path.join(os.homedir(), configuredPath.slice(1))
    : configuredPath;
  return path.resolve(rootDir, expanded);
}

function createAbsoluteFsAdapterFor(rootDir) {
  return (configuredPath) => createNodeFsAdapter(resolveConfiguredExportPath(rootDir, configuredPath));
}

// A first, deliberately minimal cut of Section 3's Albums export feature
// (see the same route in arocapi/handler.js, which the CLI here mirrors
// rather than calling over HTTP, since this needs no running server) —
// copies each of an album's member files into the export destination,
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
  const members = memberIds
    .map((id) => ({ id, relativePath: getFileById(db, id)?.relative_path, row: getEntityById(db, id) }))
    .filter((member) => member.relativePath && member.row);
  db.close();

  const exportPath = await loadExportPathSetting(fsAdapter);
  const { absoluteBase, destDir } = resolveExportTarget(album.name, exportPath);
  const destFsAdapter = absoluteBase ? createAbsoluteFsAdapterFor(rootDir)(absoluteBase) : fsAdapter;
  const { exported, errors } = await exportFiles(fsAdapter, destDir, members.map((member) => member.relativePath), destFsAdapter);

  let metadataWritten = 0;
  if (await loadExportWithMetadataSetting(fsAdapter)) {
    const exportedPaths = new Set(exported);
    const crates = new Map();
    const records = [];
    for (const { id, relativePath, row } of members) {
      if (!exportedPaths.has(relativePath)) continue;
      if (!crates.has(row.ro_crate_id)) {
        crates.set(row.ro_crate_id, loadOrCreateCrate(await readExistingCrateJson(fsAdapter, crateDirPathFromEntityId(row.ro_crate_id))));
      }
      const record = readImageRecord(crates.get(row.ro_crate_id), crateRelativeEntityId(row.ro_crate_id, id));
      if (record) records.push({ relativePath, record });
    }
    const result = await writeExportMetadata(destFsAdapter, destDir, records, writeImageMetadata);
    errors.push(...result.errors);
    metadataWritten = result.written;
  }

  const reportedDest = absoluteBase
    ? path.join(resolveConfiguredExportPath(rootDir, absoluteBase), destDir)
    : path.join(rootDir, destDir);
  console.log(`Exported ${exported.length} file(s) from "${album.name}" to ${reportedDest}`);
  if (metadataWritten > 0) {
    console.log(`Wrote metadata into ${metadataWritten} of them.`);
  }
  if (errors.length > 0) {
    console.error(`${errors.length} file(s) could not be exported:`);
    for (const { id, message } of errors) {
      console.error(`  ${id}: ${message}`);
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
  // A brand new directory, never scanned at all (no rocphotos scan CLI
  // run, and openNodeSqlite above just auto-created an empty index file)
  // gets an empty root crate and config here — idempotent, so this is
  // just as harmless to run again against an already-scanned collection.
  // This is what lets `serve` be the very first thing run against a
  // fresh collection: the admin screen (below) can then show every
  // sub-collection as not-scanned yet and let the user pick what to
  // process, rather than requiring a CLI scan first.
  await bootstrapCollection({ fsAdapter, db: store, rootName: path.basename(rootDir) });
  // Shared with the faces handler below (see its own crateCache param):
  // this is the AROCAPI handler's long-lived read cache for GET
  // /entity/{id}/metadata (the viewer's tags and "Show faces" overlay).
  // Without sharing it, a face confirmed via the faces handler would
  // update the crate file and the index correctly, but this process
  // would keep serving whichever version of that crate it last read
  // until restarted.
  const crateCache = new Map();
  // Checked up front, before the handlers that each need to know about
  // it are built: writing a confirmed face back into a photo (the faces
  // handler, below) and writing metadata into exported copies (the
  // export route) both shell out to it.
  const exiftoolAvailable = await isExiftoolAvailable();
  if (!exiftoolAvailable) {
    console.warn('Warning: the `exiftool` binary was not found — confirming a recognized face will not be able to write it back into the photo file, and an export cannot write metadata into the exported copies.');
  }
  const handleRequest = createHandler({
    store,
    fsAdapter,
    crateCache,
    createAbsoluteFsAdapter: createAbsoluteFsAdapterFor(rootDir),
    // Unlike the faces handler's writeFaceRegion below, this is not
    // gated on the collection's write-back opt-in: it only ever writes
    // to copies an export just made, never to an original (see
    // config.js's loadExportWithMetadataSetting). Still needs exiftool,
    // so it is left out entirely when that is missing, which the export
    // route reports rather than failing over.
    writeImageMetadata: exiftoolAvailable ? writeImageMetadata : null,
  });
  const handleAdminRequest = createAdminHandler({
    db: store,
    fsAdapter,
    rootName: path.basename(rootDir),
    crateCache,
    generateThumbnailFor,
  });

  const facesDbPath = path.join(rootDir, FACES_INDEX_FILE_NAME);
  fs.mkdirSync(path.dirname(facesDbPath), { recursive: true });
  const facesStore = openNodeSqlite(facesDbPath);
  ensureFacesSchema(facesStore);

  // Read once at startup, the same way exiftoolAvailable is — a change
  // made via the Settings screen while this server is already running
  // takes effect on its next restart, not immediately. Off by default,
  // for a collection with no config file at all (see
  // loadWriteMetadataToFilesSetting in config.js): a --fresh install or
  // one scanned before this setting existed never writes to original
  // files until someone explicitly turns it on.
  const writeBackEnabled = await loadWriteMetadataToFilesSetting(fsAdapter);
  if (exiftoolAvailable && !writeBackEnabled) {
    console.warn('Note: writing recognized faces back into photo files is turned off for this collection (see Settings) — confirming a face will still succeed, as crate-only metadata, until it is turned on.');
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
  const handlePeopleRequest = createPeopleHandler({ mainStore: store, facesStore, fsAdapter, crateCache });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/people/') || url.pathname === '/api/people') {
        const query = Object.fromEntries(url.searchParams);
        const body = req.method === 'POST' ? await readJsonBody(req) : null;
        const apiPath = url.pathname.slice('/api/people'.length) || '/';
        const result = await handlePeopleRequest({ method: req.method, path: apiPath, query, body });
        res.writeHead(result.status, result.headers);
        res.end(result.body instanceof Uint8Array ? Buffer.from(result.body) : result.body);
      } else if (url.pathname.startsWith('/api/faces/')) {
        const query = Object.fromEntries(url.searchParams);
        const body = req.method === 'POST' ? await readJsonBody(req) : null;
        const apiPath = url.pathname.slice('/api/faces'.length) || '/';
        const result = await handleFacesRequest({ method: req.method, path: apiPath, query, body });
        res.writeHead(result.status, result.headers);
        res.end(result.body instanceof Uint8Array ? Buffer.from(result.body) : result.body);
      } else if (url.pathname.startsWith('/api/admin/')) {
        const query = Object.fromEntries(url.searchParams);
        const body = req.method === 'POST' ? await readJsonBody(req) : null;
        const apiPath = url.pathname.slice('/api/admin'.length) || '/';
        const result = await handleAdminRequest({ method: req.method, path: apiPath, query, body });
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
  console.error('Usage: rocphotos scan <directory> [--fresh] [--reprocess] [--loose-root-images=move|ignore] [--loose-root-images-folder=<name>] [--subdir=<name>]...');
  console.error('       rocphotos export-excel <directory> [output.xlsx] [--include-entity-crates]');
  console.error('       rocphotos export-album <directory> <album name>');
  console.error('       rocphotos serve <directory> [--port=8420]');
  console.error('');
  console.error('serve binds to 127.0.0.1 only. A directory never scanned at all gets an empty');
  console.error('root crate and config bootstrapped automatically, and the web view opens');
  console.error('straight into its own "Scan Collection" admin screen to pick what to scan —');
  console.error('running rocphotos scan first is no longer required, only ever a shortcut.');
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
  console.error('');
  console.error('--subdir=<name> restricts scanning to just this sub-collection (repeatable,');
  console.error('e.g. --subdir=2006 --subdir=2019), for indexing a large collection');
  console.error('incrementally instead of in one single pass. A named subdir and everything');
  console.error('nested under it is scanned normally; every other sub-collection is left');
  console.error('entirely untouched (not even read) this run, so an incompatible or corrupt');
  console.error('crate file elsewhere in the tree never blocks the ones actually requested.');
  console.error('The root\'s own directly-contained images (see --loose-root-images) are');
  console.error('always scanned regardless. Omit it to scan the whole collection, as before.');
  process.exit(1);
}

// Splits argv into positional arguments and --key=value (or bare --key)
// flags, in any order. A flag repeated more than once (--subdir=2006
// --subdir=2019) collects into an array of its values, in the order given,
// rather than the last one silently winning — every other flag here is
// only ever passed once, so this is a no-op for them.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? true : arg.slice(eq + 1);
      if (key in flags) {
        flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : [flags[key]]), value];
      } else {
        flags[key] = value;
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
  const subdirs = flags.subdir === undefined ? [] : (Array.isArray(flags.subdir) ? flags.subdir : [flags.subdir]);
  if (mode !== undefined && mode !== 'move' && mode !== 'ignore') {
    fail(new Error(`Invalid --loose-root-images value "${mode}" (expected "move" or "ignore")`));
  } else if (subdirs.some((s) => s === true)) {
    fail(new Error('--subdir requires a value: --subdir=<name>, not a bare --subdir'));
  } else {
    scan(
      path.resolve(targetDir),
      { mode, folderName: flags['loose-root-images-folder'] },
      { fresh: Boolean(flags.fresh), reprocess: Boolean(flags.reprocess), subdirs },
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
