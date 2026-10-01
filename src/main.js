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
  recordedModifiedTime,
  readImageRecord,
  syncRootCrateSubjects,
} from './core/crateBuilder.js';
import {
  PREVIEW_FILE_NAME,
  renderSubCratePreview,
  renderRootCratePreview,
  earliestDate,
} from './core/htmlPreview.js';
import { collectPeopleForRootPreview } from './core/previews.js';
import { thumbnailPathFor } from './core/thumbnails.js';
import {
  loadExcludedDirectoryPatterns,
  loadExcludedFilePatterns,
  compileNamePatternMatcher,
  loadWriteMetadataToFilesSetting,
  setWriteMetadataToFilesSetting,
} from './core/config.js';
import { buildOverview, saveOverview, loadOverview } from './core/overview.js';
import { renderOverviewTree, selectedOverviewPaths, setAllCrateCheckboxes } from '../webview/overviewUI.js';
import { joinPath } from './core/pathUtils.js';
import { mediaTypeFor } from './core/imageTypes.js';
import { openBrowserSqlite } from './adapters/browserSqlite.js';
import {
  INDEX_FILE_NAME,
  ENTITY_TYPE_COLLECTION,
  ENTITY_TYPE_IMAGE,
  ENTITY_TYPE_PERSON,
  ENTITY_TYPE_PET,
  crateEntityId,
  imageEntityId,
  facetValuesFromRecord,
  ensureSchema,
  upsertRoCrate,
  upsertEntity,
  setEntityFacetValues,
  upsertFile,
  listDepictedSubjects,
} from './core/db/store.js';
// Vite resolves this to the built asset's final URL; sql.js's browser
// build needs to be told where to find its .wasm file explicitly rather
// than guessing a path relative to itself, which does not survive
// bundling.
import sqlWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';

const ALWAYS_RESCAN_KEY = 'rocphotos.alwaysRescan';

const openButton = document.querySelector('#open-directory');
const alwaysRescanCheckbox = document.querySelector('#always-rescan');
const writeMetadataCheckbox = document.querySelector('#write-metadata-to-files');
const writeMetadataHintEl = document.querySelector('#write-metadata-hint');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');
const overviewSectionEl = document.querySelector('#overview-section');
const overviewTreeEl = document.querySelector('#overview-tree');
const selectAllButton = document.querySelector('#overview-select-all');
const selectNoneButton = document.querySelector('#overview-select-none');
const refreshOverviewButton = document.querySelector('#overview-refresh');
const processSelectedButton = document.querySelector('#overview-process');
const browseLinkWrapEl = document.querySelector('#browse-link-wrap');

let fsAdapter = null;

// src/sw.js is a Service Worker (see there for what it does): it lands at
// a fixed /sw.js in the production build, but Vite's dev server serves
// unbundled source at its real path instead.
// BASE_URL is "/" in dev and whatever Vite was built with otherwise —
// "/rocphotos/" for the GitHub Pages build, since a project site is
// served under its repo name. The worker must be registered from, and
// scoped to, that path: a Service Worker's scope can never be broader
// than its own script's location.
const SERVICE_WORKER_URL = import.meta.env.DEV ? '/src/sw.js' : `${import.meta.env.BASE_URL}sw.js`;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // scope must be explicit: a Service Worker's default scope is its
    // own script's directory, which in dev is /src/ (the script is
    // served at /src/sw.js there) — that would leave /webview/, where
    // the requests this worker exists to intercept actually come from,
    // uncontrolled. BASE_URL covers /webview/ in both dev and the
    // published build.
    await navigator.serviceWorker.register(SERVICE_WORKER_URL, { type: 'module', scope: import.meta.env.BASE_URL });
    await navigator.serviceWorker.ready;
  } catch (err) {
    console.error('Service Worker registration failed; the /webview browsing view will not work.', err);
  }
}

// On the very first visit (no Service Worker installed yet), this page
// load is not yet "controlled" even once registration/activation
// finishes — clients.claim() in sw.js's activate handler takes control
// of it without needing a reload, but there is a short window where
// .controller is still null while that happens. Waiting once for
// 'controllerchange' covers that window without a fixed delay.
async function notifyServiceWorker(message) {
  if (!('serviceWorker' in navigator)) return;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }
  navigator.serviceWorker.controller?.postMessage(message);
}

registerServiceWorker();

alwaysRescanCheckbox.checked = localStorage.getItem(ALWAYS_RESCAN_KEY) === 'true';
alwaysRescanCheckbox.addEventListener('change', () => {
  localStorage.setItem(ALWAYS_RESCAN_KEY, String(alwaysRescanCheckbox.checked));
});

// Unlike always-rescan (a per-machine localStorage preference), this is
// a per-collection setting stored in that collection's own
// rocphotos.config.json (see loadWriteMetadataToFilesSetting/
// setWriteMetadataToFilesSetting in config.js), since it is a safety
// decision about that collection's own files, not this browser's own
// convenience — disabled here until a directory is open and there is
// somewhere to read/save it (see openDirectory below).
writeMetadataCheckbox.addEventListener('change', async () => {
  if (!fsAdapter) return;
  await setWriteMetadataToFilesSetting(fsAdapter, writeMetadataCheckbox.checked);
});

async function readExistingCrateJson(dirPath) {
  const cratePath = joinPath(dirPath, CRATE_FILE_NAME);
  if (await fsAdapter.exists(cratePath)) {
    const bytes = await fsAdapter.readFile(cratePath);
    return new TextDecoder().decode(bytes);
  }
  return null;
}

function excludeMatchers() {
  return Promise.all([
    loadExcludedDirectoryPatterns(fsAdapter).then(compileNamePatternMatcher),
    loadExcludedFilePatterns(fsAdapter).then(compileNamePatternMatcher),
  ]);
}

/**
 * Builds/updates crate metadata for the collection. `selectedPaths`, when
 * given, restricts the expensive part (reading each image's bytes,
 * extracting EXIF, generating a thumbnail) to just those sub-collections
 * — this is the whole point of the collection-overview screen: a huge,
 * decades-spanning tree does not have to pay that cost for every
 * sub-collection on every visit. A sub-collection that already has a
 * crate but is not selected this run is still folded into the root's
 * navigation from its existing (unchanged) data, so the root crate and
 * its preview always reflect everything scanned so far, not only what
 * was just processed. A sub-collection with no crate yet that is not
 * selected is left alone entirely: it will not appear until it is.
 *
 * @param {Set<string>|null} selectedPaths - null means "process everything" (used by "Always process everything on open")
 */
async function openIndex() {
  const bytes = (await fsAdapter.exists(INDEX_FILE_NAME)) ? await fsAdapter.readFile(INDEX_FILE_NAME) : null;
  const { driver, export: exportIndex } = await openBrowserSqlite(bytes, { locateFile: () => sqlWasmUrl });
  ensureSchema(driver);
  return { driver, exportIndex };
}

async function scanAndBuild(selectedPaths) {
  const [isExcludedDir, isExcludedFile] = await excludeMatchers();
  const { crateDirs } = await walkCollection(fsAdapter, isExcludedDir, isExcludedFile);

  const rootCrateJson = await readExistingCrateJson('');
  const rootCrate = loadOrCreateCrate(rootCrateJson);
  setDatasetName(rootCrate, 'Photo Collection');

  // The index is a materialised view of what scanning writes to the
  // crate JSON, same as the CLI's (see bin/rocphotos.js) — rows are only
  // ever added/updated here for a sub-collection actually processed this
  // run (shouldProcess below); one already scanned but left unselected
  // keeps whatever rows it already has from whenever it was last
  // processed (by this app or by the CLI), rather than being re-touched.
  const { driver: indexDb, exportIndex } = await openIndex();
  upsertRoCrate(indexDb, { id: crateEntityId(''), path: '.', name: 'Photo Collection' });
  upsertEntity(indexDb, { id: crateEntityId(''), roCrateId: crateEntityId(''), entityType: ENTITY_TYPE_COLLECTION, name: 'Photo Collection' });

  const items = [];
  const subCrateSummaries = [];
  let rootImageRecords = null;

  for (const { path: crateDirPath, images } of crateDirs) {
    const isRoot = crateDirPath === '';
    const alreadyScanned = !isRoot && (await fsAdapter.exists(joinPath(crateDirPath, CRATE_FILE_NAME)));
    const shouldProcess = isRoot || selectedPaths === null || selectedPaths.has(crateDirPath);

    if (!shouldProcess && !alreadyScanned) {
      // Never scanned, and not selected this run: nothing to add yet.
      continue;
    }

    if (!isRoot) {
      addSubCrateReference(rootCrate, crateDirPath);
    }

    const subCrateJson = isRoot ? rootCrateJson : await readExistingCrateJson(crateDirPath);
    const subCrate = isRoot ? rootCrate : loadOrCreateCrate(subCrateJson);
    const crateName = crateDirPath || 'Photo Collection';
    setDatasetName(subCrate, crateName);

    if (!isRoot && shouldProcess) {
      upsertRoCrate(indexDb, { id: crateEntityId(crateDirPath), path: crateDirPath, name: crateName });
      upsertEntity(indexDb, {
        id: crateEntityId(crateDirPath),
        roCrateId: crateEntityId(crateDirPath),
        entityType: ENTITY_TYPE_COLLECTION,
        name: crateName,
        memberOf: crateEntityId(''),
      });
    }

    const imageRecords = [];
    for (const imagePath of images) {
      let record;
      let thumbnailBytes = null;
      let size = null;

      if (!shouldProcess) {
        // Already scanned, but not selected this run: reuse its existing
        // record for the root's navigation summary, without touching the
        // source file at all.
        record = readImageRecord(subCrate, imagePath);
        if (!record) continue;
      } else {
        const fullImagePath = joinPath(crateDirPath, imagePath);
        const stat = await fsAdapter.stat(fullImagePath);
        const modifiedTime = stat.modifiedTime;
        size = stat.size;
        const recordedTime = recordedModifiedTime(subCrate, imagePath);

        if (recordedTime !== null && modifiedTime <= recordedTime) {
          record = readImageRecord(subCrate, imagePath);
        } else {
          statusEl.textContent = `Processing ${fullImagePath}...`;
          const bytes = await fsAdapter.readFile(fullImagePath);
          const { exif, error: exifError } = await extractExif(bytes);

          let thumbnailPath = null;
          let thumbnailError = null;
          try {
            thumbnailBytes = await generateThumbnail(bytes);
            thumbnailPath = thumbnailPathFor(imagePath);
            await fsAdapter.writeFile(joinPath(crateDirPath, thumbnailPath), thumbnailBytes);
          } catch (thumbErr) {
            thumbnailError = `Thumbnail generation failed: ${thumbErr.message}`;
            thumbnailBytes = null;
          }

          record = addImageEntity(subCrate, {
            path: imagePath,
            exif,
            exifError,
            thumbnailPath,
            thumbnailError,
            sourceModifiedAt: modifiedTime,
          });
        }

        const entityId = imageEntityId(crateDirPath, imagePath);
        upsertEntity(indexDb, {
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
        setEntityFacetValues(indexDb, entityId, 'camera', camera ? [camera] : []);
        setEntityFacetValues(indexDb, entityId, 'lens', lens ? [lens] : []);
        setEntityFacetValues(indexDb, entityId, 'keyword', record.keywords);
        setEntityFacetValues(indexDb, entityId, 'rating', record.rating !== null ? [String(record.rating)] : []);
        setEntityFacetValues(indexDb, entityId, 'people', record.people);
        setEntityFacetValues(indexDb, entityId, 'pets', record.pets);
        // The id the crate records, not one recomputed from the name —
        // the same rule scanCollection follows, and for the same
        // reason: an identity is minted once and frozen (see
        // core/subjects.js), so a renamed person must not be given a
        // second row under a brand new id.
        for (const { id, name, subjectType } of record.subjects ?? []) {
          upsertEntity(indexDb, { id, roCrateId: crateEntityId(crateDirPath), entityType: subjectType === 'Pet' ? ENTITY_TYPE_PET : ENTITY_TYPE_PERSON, name });
        }
        upsertFile(indexDb, {
          id: entityId,
          entityId,
          filename: record.name,
          mediaType: mediaTypeFor(record.name),
          size,
          relativePath: entityId,
        });
      }

      imageRecords.push(record);
      items.push({ ...record, crateDir: crateDirPath, thumbnailBytes });
    }

    if (isRoot) {
      // The root directory itself directly contains images: it is both the
      // root crate and the only crate, so its preview is a thumbnail
      // gallery rather than date-based navigation into sub-collections.
      rootImageRecords = imageRecords;
    } else {
      if (shouldProcess) {
        await fsAdapter.writeFile(joinPath(crateDirPath, CRATE_FILE_NAME), serializeCrate(subCrate));
        const depth = crateDirPath.split('/').length;
        const backLink = '../'.repeat(depth) + PREVIEW_FILE_NAME;
        const html = renderSubCratePreview({ name: crateName, images: imageRecords, backLink });
        await fsAdapter.writeFile(joinPath(crateDirPath, PREVIEW_FILE_NAME), html);
      }
      subCrateSummaries.push({ path: crateDirPath, imageCount: images.length, representativeDate: earliestDate(imageRecords) });
    }
  }

  // See scanCollection.js: the collection-wide Person/Pet entities are
  // the root crate's own, rebuilt from the index.
  syncRootCrateSubjects(rootCrate, listDepictedSubjects(indexDb));
  await fsAdapter.writeFile(CRATE_FILE_NAME, serializeCrate(rootCrate));
  const rootHtml = rootImageRecords
    ? renderSubCratePreview({ name: 'Photo Collection', images: rootImageRecords })
    : renderRootCratePreview({ name: 'Photo Collection', subCrates: subCrateSummaries, people: collectPeopleForRootPreview(indexDb) });
  await fsAdapter.writeFile(PREVIEW_FILE_NAME, rootHtml);

  await fsAdapter.writeFile(INDEX_FILE_NAME, exportIndex());
  indexDb.close();

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
    if (item.processingError) {
      const errorLine = document.createElement('div');
      errorLine.className = 'error';
      errorLine.textContent = item.processingError;
      caption.appendChild(errorLine);
    }
    figure.appendChild(caption);

    resultsEl.appendChild(figure);
  }
}

/**
 * Loads the persisted collection map (see core/overview.js) if there is
 * one, or builds a fresh one otherwise — a cheap directory walk plus one
 * modification-time check per image, never reading an image's bytes.
 * Rebuilding the overview after processing keeps its status current
 * without a second explicit "Refresh" step.
 */
async function showOverview({ forceRefresh = false } = {}) {
  statusEl.textContent = 'Checking collection status...';
  const [isExcludedDir, isExcludedFile] = await excludeMatchers();
  let overview = forceRefresh ? null : await loadOverview(fsAdapter);
  if (!overview) {
    overview = await buildOverview(fsAdapter, isExcludedDir, isExcludedFile);
    await saveOverview(fsAdapter, overview);
  }
  renderOverviewTree({ sectionEl: overviewSectionEl, treeEl: overviewTreeEl, overview });
  return overview;
}

async function openDirectory() {
  // 'readwrite' matters even though this page only ever writes during a
  // click: the picker's default is read-only, and Chrome then prompts
  // for write access on the first createWritable() call. A page can
  // answer that prompt because a click gives it user activation; the
  // Service Worker never has any, so a write it makes (regenerating
  // previews, scanning, saving the index) would fail outright. Asking
  // here, once, grants the whole handle — including the copy handed to
  // the worker below.
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  fsAdapter = createBrowserFsAdapter(handle);
  // The Service Worker cannot call showDirectoryPicker itself (no user
  // gesture in that context), so the handle this page just obtained is
  // handed to it directly — FileSystemDirectoryHandle is structured-clone
  // safe, including across postMessage to a Service Worker.
  await notifyServiceWorker({ type: 'set-root', handle });
  browseLinkWrapEl.hidden = false;

  writeMetadataCheckbox.disabled = false;
  writeMetadataCheckbox.checked = await loadWriteMetadataToFilesSetting(fsAdapter);
  writeMetadataHintEl.hidden = true;

  if (alwaysRescanCheckbox.checked) {
    statusEl.textContent = 'Processing everything...';
    const items = await scanAndBuild(null);
    await notifyServiceWorker({ type: 'index-updated' });
    await renderItems(items);
    await showOverview({ forceRefresh: true });
    statusEl.textContent = `${items.length} image(s) across ${new Set(items.map((i) => i.crateDir)).size} crate(s).`;
    return;
  }

  await showOverview();
  statusEl.textContent = 'Select which sub-collections to process below, or open one already processed to browse it.';
}

async function processSelected() {
  const selectedPaths = selectedOverviewPaths(overviewTreeEl);
  if (selectedPaths.size === 0) {
    statusEl.textContent = 'Nothing selected.';
    return;
  }

  try {
    const items = await scanAndBuild(selectedPaths);
    await notifyServiceWorker({ type: 'index-updated' });
    await renderItems(items);
    await showOverview({ forceRefresh: true });
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

selectAllButton.addEventListener('click', () => setAllCrateCheckboxes(overviewTreeEl, true));
selectNoneButton.addEventListener('click', () => setAllCrateCheckboxes(overviewTreeEl, false));

refreshOverviewButton.addEventListener('click', () => {
  showOverview({ forceRefresh: true }).catch((err) => {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
  });
});

processSelectedButton.addEventListener('click', () => {
  statusEl.textContent = 'Processing selected sub-collections...';
  processSelected();
});
