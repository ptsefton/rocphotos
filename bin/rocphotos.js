#!/usr/bin/env node
import path from 'node:path';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { generateThumbnail } from '../src/adapters/nodeThumbnail.js';
import { walkCollection } from '../src/core/walker.js';
import { extractExif } from '../src/core/exif.js';
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
import { loadExcludedDirectoryPatterns, compileDirectoryExclusionMatcher } from '../src/core/config.js';
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

async function scan(rootDir) {
  const fsAdapter = createNodeFsAdapter(rootDir);
  const isExcluded = compileDirectoryExclusionMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  const { crateDirs } = await walkCollection(fsAdapter, isExcluded);

  const rootCrateJson = await readExistingCrateJson(fsAdapter, '');
  const rootCrate = loadOrCreateCrate(rootCrateJson);
  const rootName = path.basename(rootDir);
  setDatasetName(rootCrate, rootName);

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

    const imageRecords = [];
    for (const imagePath of images) {
      const bytes = await fsAdapter.readFile(joinPath(crateDirPath, imagePath));
      const { exif, error } = await extractExif(bytes);
      const thumbnailPath = await ensureThumbnail(fsAdapter, crateDirPath, imagePath, bytes);
      imageRecords.push(addImageEntity(subCrate, { path: imagePath, exif, exifError: error, thumbnailPath }));
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

  console.log(`Scanned ${crateDirs.length} crate(s) under ${rootDir}`);
  for (const { path: crateDirPath, images } of crateDirs) {
    console.log(`  ${crateDirPath || '(root)'}: ${images.length} image(s)`);
  }
}

const [, , command, targetDir] = process.argv;

if (command !== 'scan' || !targetDir) {
  console.error('Usage: rocphotos scan <directory>');
  process.exit(1);
}

scan(path.resolve(targetDir)).catch((err) => {
  console.error(err);
  process.exit(1);
});
