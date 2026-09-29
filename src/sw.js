// Intercepts /api/* requests from the browser SPA's own pages (chiefly
// /webview/, the same static web view the CLI's `serve` command hosts
// over node:http) and answers them from the AROCAPI handler running
// in-page over a File System Access API directory handle, instead of a
// real server — so the same web view works without one. Registered as a
// module Service Worker (see registerServiceWorker in main.js) so it can
// import the exact same handler, driver, and adapter code the rest of
// the app uses, rather than a hand-duplicated copy that could drift out
// of sync with it.
import { createBrowserFsAdapter } from './adapters/browserFs.js';
import { openBrowserSqlite } from './adapters/browserSqlite.js';
import { createHandler } from './core/arocapi/handler.js';
import { createFacesHandler } from './core/faces/handler.js';
import { createPeopleHandler } from './core/people/handler.js';
import { ensureFacesSchema, FACES_INDEX_FILE_NAME } from './core/faces/store.js';
import { ensureSchema, INDEX_FILE_NAME } from './core/db/store.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';

const HANDLE_DB_NAME = 'rocphotos-sw';
const HANDLE_STORE_NAME = 'handles';
const HANDLE_KEY = 'root';

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveHandle(handle) {
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
    tx.objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
    const request = tx.objectStore(HANDLE_STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

// Rebuilt lazily on the first /api/* request this Service Worker
// instance handles (the browser can terminate and restart a Service
// Worker at any time, so nothing about its own JS-level state, including
// this cache, can be relied on to survive between requests — only what
// is in IndexedDB, or read fresh from disk, can be). Cleared by the
// 'index-updated' message the main page sends after it finishes writing
// a fresh index, so a change made there is reflected on the very next
// request rather than only after this worker happens to restart.
let context = null;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'set-root') {
    event.waitUntil(saveHandle(event.data.handle).then(() => { context = null; }));
  } else if (event.data?.type === 'index-updated') {
    context = null;
  }
});

async function buildContext() {
  const handle = await loadHandle();
  if (!handle) {
    return { error: { status: 404, message: 'No collection has been opened yet — open the app tab and click "Open Directory".' } };
  }

  const permission = await handle.queryPermission({ mode: 'read' });
  if (permission !== 'granted') {
    // A Service Worker cannot itself prompt for permission (there is no
    // user gesture in this context) — only a window can, so the fix has
    // to happen there.
    return { error: { status: 409, message: 'Access to the collection needs to be re-granted — open the app tab and click "Open Directory" again.' } };
  }

  const fsAdapter = createBrowserFsAdapter(handle);
  if (!(await fsAdapter.exists(INDEX_FILE_NAME))) {
    return { error: { status: 404, message: 'This collection has not been scanned yet.' } };
  }

  const bytes = await fsAdapter.readFile(INDEX_FILE_NAME);
  const { driver, export: exportIndex } = await openBrowserSqlite(bytes, { locateFile: () => sqlWasmUrl });
  // sql.js operates entirely in memory; unlike node:sqlite (already
  // backed directly by the real file), a change here is only durable
  // once explicitly exported and written back — createHandler's edit
  // routes call this after every write, via the optional store.persist().
  const store = { ...driver, persist: () => fsAdapter.writeFile(INDEX_FILE_NAME, exportIndex()) };
  // Applies any schema additions made since this index was last built to
  // an existing database's bytes, the same way ensureFacesSchema below
  // already does for the faces store — see the equivalent fix and
  // comment in bin/rocphotos.js's serve().
  ensureSchema(store);

  // The faces companion index (see Spec.md's Face Recognition section)
  // is a second, separate SQLite file, created fresh here the first time
  // a collection is opened in this mode (openBrowserSqlite accepts
  // null/undefined bytes for that) — regenerable, not a second source of
  // truth for anything the main index or the photo crates already hold.
  const facesBytes = (await fsAdapter.exists(FACES_INDEX_FILE_NAME)) ? await fsAdapter.readFile(FACES_INDEX_FILE_NAME) : null;
  const { driver: facesDriver, export: exportFacesIndex } = await openBrowserSqlite(facesBytes, { locateFile: () => sqlWasmUrl });
  const facesStore = { ...facesDriver, persist: () => fsAdapter.writeFile(FACES_INDEX_FILE_NAME, exportFacesIndex()) };
  ensureFacesSchema(facesStore);

  return { fsAdapter, driver: store, facesStore };
}

async function ensureContext() {
  if (!context) {
    context = await buildContext();
  }
  return context;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// This worker's own mount point: "/" when the app is served from the
// root, "/irocrate/" when published under a project path on GitHub
// Pages. Every /api match below is made against the path *after* it, so
// one build works either way — and so it agrees with how webview/app.js
// derives the same prefix from its own location.
function scopeRelativePath(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  return url.pathname.slice(scopePath.length - 1);
}

async function handleApiRequest(request, url) {
  const path = scopeRelativePath(url);
  const ctx = await ensureContext();
  if (ctx.error) {
    return jsonResponse(ctx.error.status, { error: ctx.error.message });
  }

  const query = Object.fromEntries(url.searchParams);
  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }

  if (path.startsWith('/api/faces/')) {
    const apiPath = path.slice('/api/faces'.length) || '/';
    // No writeFaceRegion here: a Service Worker cannot shell out to the
    // system exiftool binary, so /faces/confirm returns a clear error in
    // this run mode (see createFacesHandler) rather than silently
    // updating the crate/index without also updating the photo file.
    const handleFacesRequest = createFacesHandler({ mainStore: ctx.driver, facesStore: ctx.facesStore, fsAdapter: ctx.fsAdapter });
    const result = await handleFacesRequest({ method: request.method, path: apiPath, query, body });
    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  if (path.startsWith('/api/people/') || path === '/api/people') {
    const apiPath = path.slice('/api/people'.length) || '/';
    // A merge never touches a photo file, only crate JSON-LD and the two
    // SQLite indexes — unlike /faces/confirm above, this behaves
    // identically in every run mode, so no capability is missing here.
    const handlePeopleRequest = createPeopleHandler({ mainStore: ctx.driver, facesStore: ctx.facesStore, fsAdapter: ctx.fsAdapter });
    const result = await handlePeopleRequest({ method: request.method, path: apiPath, query, body });
    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  const apiPath = path.slice('/api'.length) || '/';
  const handleRequest = createHandler({ store: ctx.driver, fsAdapter: ctx.fsAdapter });
  const result = await handleRequest({ method: request.method, path: apiPath, query, body });
  return new Response(result.body, { status: result.status, headers: result.headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const path = scopeRelativePath(url);
  if (path.startsWith('/api/') || path === '/api') {
    event.respondWith(handleApiRequest(event.request, url));
  }
});
