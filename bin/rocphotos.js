#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import ExcelJS from 'exceljs';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { generateThumbnail } from '../src/adapters/nodeThumbnail.js';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';
import { walkCollection, detectLooseRootImages } from '../src/core/walker.js';
import { extractExif } from '../src/core/exif.js';
import { mediaTypeFor } from '../src/core/imageTypes.js';
import {
  CRATE_FILE_NAME,
  loadOrCreateCrate,
  serializeCrate,
  setDatasetName,
  addSubCrateReference,
  addImageEntity,
} from '../src/core/crateBuilder.js';
import {
  PREVIEW_FILE_NAME,
  renderSubCratePreview,
  renderRootCratePreview,
  earliestDate,
} from '../src/core/htmlPreview.js';
import { thumbnailPathFor } from '../src/core/thumbnails.js';
import {
  loadExcludedDirectoryPatterns,
  loadExcludedFilePatterns,
  compileNamePatternMatcher,
  addExcludedFiles,
} from '../src/core/config.js';
import {
  INDEX_FILE_NAME,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
  crateEntityId,
  imageEntityId,
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  upsertFile,
  listRoCrates,
  listEntities,
  listFiles,
} from '../src/core/db/store.js';
import { joinPath } from '../src/core/pathUtils.js';

async function readExistingCrateJson(fsAdapter, dirPath) {
  const cratePath = joinPath(dirPath, CRATE_FILE_NAME);
  if (await fsAdapter.exists(cratePath)) {
    const bytes = await fsAdapter.readFile(cratePath);
    return Buffer.from(bytes).toString('utf8');
  }
  return null;
}

// Ensures a thumbnail exists for an image, reusing one already on disk
// (whether left by a previous CLI run or by the browser SPA) rather than
// regenerating it. Returns the thumbnail's path, relative to the crate
// directory, or null if none exists and one could not be generated (some
// formats are not supported by the installed libvips build).
async function ensureThumbnail(fsAdapter, crateDirPath, imagePath, bytes) {
  const thumbnailPath = thumbnailPathFor(imagePath);
  const fullThumbnailPath = joinPath(crateDirPath, thumbnailPath);

  if (!(await fsAdapter.exists(fullThumbnailPath))) {
    try {
      const thumbnailBytes = await generateThumbnail(bytes);
      await fsAdapter.writeFile(fullThumbnailPath, thumbnailBytes);
    } catch (err) {
      console.warn(`Could not generate thumbnail for ${joinPath(crateDirPath, imagePath)}: ${err.message}`);
      return null;
    }
  }

  return thumbnailPath;
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

// Detects images sitting loose directly in the collection root (see
// detectLooseRootImages) and, if any are found, interactively offers to
// either move them into a new subfolder (so they become a normal
// sub-collection crate) or record them in rocphotos.config.json so they
// are ignored on this and future scans. Left unresolved, they would
// silently make the whole root a single crate and hide every
// subdirectory crate beneath it.
async function resolveLooseRootImages(fsAdapter, rootDir, isExcludedDir, isExcludedFile) {
  const looseImages = await detectLooseRootImages(fsAdapter, isExcludedDir, isExcludedFile);
  if (looseImages.length === 0) {
    return;
  }

  console.log(`\nFound ${looseImages.length} image file(s) directly in the root of this collection, alongside other subdirectories:`);
  for (const name of looseImages) {
    console.log(`  ${name}`);
  }
  console.log('\nLeft as they are, these would make the whole root a single crate and prevent any of the subdirectories below from becoming their own crates.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = (await rl.question(
      'What would you like to do?\n'
      + '  1) Move them into a new folder (e.g. "images/")\n'
      + '  2) Ignore them (record in rocphotos.config.json)\n'
      + '  3) Do nothing, cancel this scan\n'
      + 'Choice [1/2/3]: ',
    )).trim();
  } finally {
    rl.close();
  }

  if (answer === '1') {
    const folderName = findAvailableFolderName(rootDir, 'images');
    fs.mkdirSync(path.join(rootDir, folderName));
    for (const name of looseImages) {
      fs.renameSync(path.join(rootDir, name), path.join(rootDir, folderName, name));
    }
    console.log(`Moved ${looseImages.length} image(s) into ${folderName}/.\n`);
  } else if (answer === '2') {
    await addExcludedFiles(fsAdapter, looseImages);
    console.log(`Added ${looseImages.length} filename(s) to excludeFiles in rocphotos.config.json.\n`);
  } else {
    throw new Error('Scan cancelled: resolve the loose root images (move or configure them to be ignored), then re-run scan.');
  }
}

async function scan(rootDir) {
  const fsAdapter = createNodeFsAdapter(rootDir);
  let isExcludedDir = compileNamePatternMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  let isExcludedFile = compileNamePatternMatcher(await loadExcludedFilePatterns(fsAdapter));

  await resolveLooseRootImages(fsAdapter, rootDir, isExcludedDir, isExcludedFile);
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
  upsertRoCrate(db, { id: '', path: '', name: rootName });
  upsertEntity(db, { id: crateEntityId(''), roCrateId: '', entityType: ENTITY_TYPE_COLLECTION, name: rootName, memberOf: null });

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
      upsertRoCrate(db, { id: crateDirPath, path: crateDirPath, name: crateName });
      upsertEntity(db, {
        id: crateEntityId(crateDirPath),
        roCrateId: crateDirPath,
        entityType: ENTITY_TYPE_COLLECTION,
        name: crateName,
        memberOf: crateEntityId(''),
      });
    }

    const imageRecords = [];
    for (const imagePath of images) {
      const bytes = await fsAdapter.readFile(joinPath(crateDirPath, imagePath));
      const { exif, error } = await extractExif(bytes);
      const thumbnailPath = await ensureThumbnail(fsAdapter, crateDirPath, imagePath, bytes);
      const record = addImageEntity(subCrate, { path: imagePath, exif, exifError: error, thumbnailPath });
      imageRecords.push(record);

      const entityId = imageEntityId(crateDirPath, imagePath);
      upsertEntity(db, {
        id: entityId,
        roCrateId: crateDirPath,
        entityType: ENTITY_TYPE_IMAGE,
        name: record.name,
        description: record.description,
        memberOf: crateEntityId(crateDirPath),
      });
      upsertFile(db, {
        id: entityId,
        entityId,
        filename: record.name,
        mediaType: mediaTypeFor(record.name),
        size: bytes.length,
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

async function exportExcel(rootDir, outputPath) {
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
    { header: 'description', key: 'description', width: 40 },
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

  await workbook.xlsx.writeFile(outputPath);
  console.log(`Wrote ${roCrates.length} RO-Crate(s), ${entities.length} entities, ${files.length} files to ${outputPath}`);
}

function fail(err) {
  console.error(err.message ?? err);
  process.exit(1);
}

function usage() {
  console.error('Usage: rocphotos scan <directory>');
  console.error('       rocphotos export-excel <directory> [output.xlsx]');
  process.exit(1);
}

const [, , command, targetDir, extraArg] = process.argv;

if (command === 'scan' && targetDir) {
  scan(path.resolve(targetDir)).catch(fail);
} else if (command === 'export-excel' && targetDir) {
  const resolvedDir = path.resolve(targetDir);
  const outputPath = path.resolve(extraArg || path.join(resolvedDir, 'rocphotos-index.xlsx'));
  exportExcel(resolvedDir, outputPath).catch(fail);
} else {
  usage();
}
