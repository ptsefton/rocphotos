import { createBrowserFsAdapter } from './adapters/browserFs.js';
import { generateThumbnail } from './adapters/browserThumbnail.js';
import { walkCollection } from './core/walker.js';
import { extractExif } from './core/exif.js';
import {
  CRATE_FILE_NAME,
  loadOrCreateCrate,
  serializeCrate,
  setDatasetName,
  addSubCrateReference,
  addImageEntity,
} from './core/crateBuilder.js';
import {
  PREVIEW_FILE_NAME,
  renderSubCratePreview,
  renderRootCratePreview,
  earliestDate,
} from './core/htmlPreview.js';
import { thumbnailPathFor } from './core/thumbnails.js';
import { loadExcludedDirectoryPatterns, compileDirectoryExclusionMatcher } from './core/config.js';
import { joinPath } from './core/pathUtils.js';

const ALWAYS_RESCAN_KEY = 'rocphotos.alwaysRescan';

const openButton = document.querySelector('#open-directory');
const rescanButton = document.querySelector('#rescan');
const alwaysRescanCheckbox = document.querySelector('#always-rescan');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');

let fsAdapter = null;

alwaysRescanCheckbox.checked = localStorage.getItem(ALWAYS_RESCAN_KEY) === 'true';
alwaysRescanCheckbox.addEventListener('change', () => {
  localStorage.setItem(ALWAYS_RESCAN_KEY, String(alwaysRescanCheckbox.checked));
});

function typeIncludes(entity, type) {
  const types = Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']];
  return types.includes(type);
}

async function readExistingCrateJson(dirPath) {
  const cratePath = joinPath(dirPath, CRATE_FILE_NAME);
  if (await fsAdapter.exists(cratePath)) {
    const bytes = await fsAdapter.readFile(cratePath);
    return new TextDecoder().decode(bytes);
  }
  return null;
}

// Rebuilds crate metadata by walking the filesystem, extracting EXIF data,
// and generating thumbnails. Used for the initial scan of a directory, and
// whenever the user explicitly asks to rescan.
async function scanAndBuild() {
  const isExcluded = compileDirectoryExclusionMatcher(await loadExcludedDirectoryPatterns(fsAdapter));
  const { crateDirs } = await walkCollection(fsAdapter, isExcluded);

  const rootCrateJson = await readExistingCrateJson('');
  const rootCrate = loadOrCreateCrate(rootCrateJson);
  setDatasetName(rootCrate, 'Photo Collection');

  const items = [];
  const subCrateSummaries = [];
  let rootImageRecords = null;

  for (const { path: crateDirPath, images } of crateDirs) {
    const isRoot = crateDirPath === '';
    if (!isRoot) {
      addSubCrateReference(rootCrate, crateDirPath);
    }

    const subCrateJson = isRoot ? rootCrateJson : await readExistingCrateJson(crateDirPath);
    const subCrate = isRoot ? rootCrate : loadOrCreateCrate(subCrateJson);
    const crateName = crateDirPath || 'Photo Collection';
    setDatasetName(subCrate, crateName);

    const imageRecords = [];
    for (const imagePath of images) {
      statusEl.textContent = `Processing ${joinPath(crateDirPath, imagePath)}...`;
      const bytes = await fsAdapter.readFile(joinPath(crateDirPath, imagePath));
      const { exif, error } = await extractExif(bytes);

      // Reuse a thumbnail already on disk (from a previous CLI or browser
      // scan) instead of regenerating it on every rescan.
      let thumbnailPath = thumbnailPathFor(imagePath);
      let thumbnailBytes = null;
      const existingThumbnail = await fsAdapter.exists(joinPath(crateDirPath, thumbnailPath));
      if (!existingThumbnail) {
        try {
          thumbnailBytes = await generateThumbnail(bytes);
          await fsAdapter.writeFile(joinPath(crateDirPath, thumbnailPath), thumbnailBytes);
        } catch (thumbErr) {
          console.warn(`Could not generate thumbnail for ${imagePath}:`, thumbErr);
          thumbnailPath = null;
        }
      }

      const record = addImageEntity(subCrate, { path: imagePath, exif, exifError: error, thumbnailPath });
      imageRecords.push(record);
      items.push({ ...record, crateDir: crateDirPath, thumbnailBytes });
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
    ? renderSubCratePreview({ name: 'Photo Collection', images: rootImageRecords })
    : renderRootCratePreview({ name: 'Photo Collection', subCrates: subCrateSummaries });
  await fsAdapter.writeFile(PREVIEW_FILE_NAME, rootHtml);

  return items;
}

// Reads previously built crate metadata without touching the filesystem
// walk, per the default "trust existing metadata" behaviour.
async function loadExisting() {
  const rootJson = await readExistingCrateJson('');
  if (!rootJson) return null;

  const rootCrate = loadOrCreateCrate(rootJson);
  const hasPart = rootCrate.rootDataset.hasPart ?? [];
  const items = [];

  for (const ref of hasPart) {
    const crateDir = ref['@id'].replace(/\/$/, '');
    const subJson = await readExistingCrateJson(crateDir);
    if (!subJson) continue;

    const subCrate = loadOrCreateCrate(subJson);
    const subHasPart = subCrate.rootDataset.hasPart ?? [];

    for (const partRef of subHasPart) {
      const entity = subCrate.getEntity(partRef['@id']);
      if (!entity || !typeIncludes(entity, 'ImageObject')) continue;

      items.push({
        crateDir,
        name: entity.name,
        description: entity.description ?? null,
        thumbnailBytes: null,
        thumbnailPath: entity.thumbnail?.['@id'] ?? null,
      });
    }
  }

  return items;
}

async function renderItems(items) {
  resultsEl.innerHTML = '';
  for (const item of items) {
    let bytes = item.thumbnailBytes;
    if (!bytes && item.thumbnailPath) {
      try {
        bytes = await fsAdapter.readFile(joinPath(item.crateDir, item.thumbnailPath));
      } catch {
        bytes = null;
      }
    }

    const figure = document.createElement('figure');

    const img = document.createElement('img');
    if (bytes) {
      img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    }
    img.alt = item.name;
    figure.appendChild(img);

    const caption = document.createElement('figcaption');
    caption.innerHTML = `${item.name}<br><span class="crate-dir">${item.crateDir || '(root)'}</span>`;
    if (item.description) {
      const errorLine = document.createElement('div');
      errorLine.className = 'error';
      errorLine.textContent = item.description;
      caption.appendChild(errorLine);
    }
    figure.appendChild(caption);

    resultsEl.appendChild(figure);
  }
}

async function openDirectory() {
  const handle = await window.showDirectoryPicker();
  fsAdapter = createBrowserFsAdapter(handle);
  rescanButton.disabled = false;
  await refresh({ forceRescan: alwaysRescanCheckbox.checked });
}

async function refresh({ forceRescan }) {
  statusEl.textContent = 'Loading...';
  try {
    let items = forceRescan ? null : await loadExisting();
    if (!items) {
      items = await scanAndBuild();
    }
    await renderItems(items);
    statusEl.textContent = `${items.length} image(s) across ${new Set(items.map((i) => i.crateDir)).size} crate(s).`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
  }
}

openButton.addEventListener('click', () => {
  openDirectory().catch((err) => {
    if (err.name !== 'AbortError') {
      console.error(err);
      statusEl.textContent = `Error: ${err.message}`;
    }
  });
});

rescanButton.addEventListener('click', () => {
  refresh({ forceRescan: true });
});
