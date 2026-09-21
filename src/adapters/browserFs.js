async function getDirectoryHandle(rootHandle, relPath, { create = false } = {}) {
  let handle = rootHandle;
  const parts = (relPath || '').split('/').filter(Boolean);
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part, { create });
  }
  return handle;
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
  const adapter = {
    async readDir(relPath) {
      const dirHandle = await getDirectoryHandle(rootHandle, relPath);
      const entries = [];
      for await (const [name, handle] of dirHandle.entries()) {
        entries.push({ name, isDirectory: handle.kind === 'directory' });
      }
      return entries;
    },

    async readFile(relPath) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await getDirectoryHandle(rootHandle, parentPath);
      const fileHandle = await dirHandle.getFileHandle(name);
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },

    async stat(relPath) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await getDirectoryHandle(rootHandle, parentPath);
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
        const dirHandle = await getDirectoryHandle(rootHandle, parentPath);
        await dirHandle.getFileHandle(name);
        return true;
      } catch {
        // fall through to try it as a directory
      }
      try {
        const dirHandle = await getDirectoryHandle(rootHandle, parentPath);
        await dirHandle.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    },

    async writeFile(relPath, data) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await getDirectoryHandle(rootHandle, parentPath, { create: true });
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
    },

    async deleteFile(relPath) {
      const { parentPath, name } = splitParent(relPath);
      const dirHandle = await getDirectoryHandle(rootHandle, parentPath);
      await dirHandle.removeEntry(name);
    },
  };

  return adapter;
}
