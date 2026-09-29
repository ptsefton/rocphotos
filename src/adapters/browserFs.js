async function getDirectoryHandle(rootHandle, relPath, { create = false } = {}) {
  let handle = rootHandle;
  const parts = (relPath || '').split('/').filter(Boolean);
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part, { create });
  }
  return handle;
}

/**
 * getDirectoryHandle above walks from the root every time, and each step
 * of that walk is a round trip to the browser process. Since every
 * readFile/writeFile/exists call starts its own walk, a run that touches
 * many files in a few directories spends most of its time resolving the
 * same directories over and over: regenerating previews for a 64K-photo
 * collection made 7,200 of these calls for roughly 800 distinct
 * directories.
 *
 * Caching the promise rather than the handle matters once callers run
 * concurrently — several files in one directory then share a single walk
 * instead of each starting their own.
 *
 * A cached handle stays valid as long as the directory does. If one is
 * deleted and recreated outside the app, the stale handle throws
 * NotFoundError on use, so the miss is reported rather than silently
 * writing somewhere wrong; reopening the collection builds a fresh cache.
 */
function createDirectoryHandleCache(rootHandle) {
  const cache = new Map();

  // Every prefix is cached, not only the path asked for, so sibling
  // directories share the walk down to their common parent: once
  // 2005/03/holiday has been resolved, 2005/03/wedding costs one step
  // rather than three.
  const resolve = (key, create) => {
    if (!key) return Promise.resolve(rootHandle);
    const hit = cache.get(key);
    if (hit) return hit;

    const cut = key.lastIndexOf('/');
    const parentKey = cut === -1 ? '' : key.slice(0, cut);
    const name = cut === -1 ? key : key.slice(cut + 1);
    const pending = resolve(parentKey, create)
      .then((parent) => parent.getDirectoryHandle(name, { create }))
      .catch((err) => {
        // A failed walk must not be remembered: the directory may exist
        // by the next call, and with `create` it will.
        cache.delete(key);
        throw err;
      });

    cache.set(key, pending);
    return pending;
  };

  // Normalised so that '', 'a/b' and 'a//b/' share one cache entry.
  return (relPath, { create = false } = {}) => resolve((relPath || '').split('/').filter(Boolean).join('/'), create);
}

function splitParent(relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop();
  return { parentPath: parts.join('/'), name };
}

/**
 * Browser implementation of the core FsAdapter interface, backed by the
 * File System Access API. `rootHandle` is the FileSystemDirectoryHandle
 * granted by the user via a directory picker.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @returns {import('../core/fsAdapter.js').FsAdapter}
 */
export function createBrowserFsAdapter(rootHandle) {
  const directoryHandle = createDirectoryHandleCache(rootHandle);
  const adapter = {
    async readDir(relPath) {
      const dirHandle = await directoryHandle(relPath);
      const entries = [];
      for await (const [name, handle] of dirHandle.entries()) {
        entries.push({ name, isDirectory: handle.kind === 'directory' });
      }
      return entries;
    },

    async readFile(relPath) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await directoryHandle(parentPath);
      const fileHandle = await dirHandle.getFileHandle(name);
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },

    async stat(relPath) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await directoryHandle(parentPath);
      const fileHandle = await dirHandle.getFileHandle(name);
      const file = await fileHandle.getFile();
      // File.lastModified is specified as integer milliseconds already,
      // but floored defensively to match the adapter contract exactly
      // (see nodeFs.js's stat for why sub-millisecond precision matters).
      return { modifiedTime: Math.floor(file.lastModified), size: file.size };
    },

    async exists(relPath) {
      const { parentPath, name } = splitParent(relPath);
      try {
        const dirHandle = await directoryHandle(parentPath);
        await dirHandle.getFileHandle(name);
        return true;
      } catch {
        // fall through to try it as a directory
      }
      try {
        const dirHandle = await directoryHandle(parentPath);
        await dirHandle.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    },

    async writeFile(relPath, data) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await directoryHandle(parentPath, { create: true });
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
    },

    async deleteFile(relPath) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await directoryHandle(parentPath);
      await dirHandle.removeEntry(name);
    },
  };

  return adapter;
}
