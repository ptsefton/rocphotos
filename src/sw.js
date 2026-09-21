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
import { INDEX_FILE_NAME } from './core/db/store.js';
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
  const { driver } = await openBrowserSqlite(bytes, { locateFile: () => sqlWasmUrl });
  return { fsAdapter, driver };
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

async function handleApiRequest(request, url) {
  const ctx = await ensureContext();
  if (ctx.error) {
    return jsonResponse(ctx.error.status, { error: ctx.error.message });
  }

  const apiPath = url.pathname.slice('/api'.length) || '/';
  const query = Object.fromEntries(url.searchParams);
  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }

  const handleRequest = createHandler({ store: ctx.driver, fsAdapter: ctx.fsAdapter });
  const result = await handleRequest({ method: request.method, path: apiPath, query, body });
  return new Response(result.body, { status: result.status, headers: result.headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
    event.respondWith(handleApiRequest(event.request, url));
  }
});
