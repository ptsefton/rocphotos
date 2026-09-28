import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Node.js implementation of the core FsAdapter interface, backed by the
 * real filesystem with full, unrestricted access. Used by the command-line
 * tool and by the test suite, so that directory walking, EXIF extraction,
 * and crate construction can be exercised outside the browser.
 *
 * @param {string} rootDir absolute path to the directory being managed
 * @returns {import('../core/fsAdapter.js').FsAdapter}
 */
export function createNodeFsAdapter(rootDir) {
  const resolve = (relPath) => path.join(rootDir, relPath || '');

  return {
    async readDir(relPath) {
      const dirents = await fs.readdir(resolve(relPath), { withFileTypes: true });
      return dirents.map((dirent) => ({ name: dirent.name, isDirectory: dirent.isDirectory() }));
    },

    async readFile(relPath) {
      return new Uint8Array(await fs.readFile(resolve(relPath)));
    },

    async exists(relPath) {
      try {
        await fs.access(resolve(relPath));
        return true;
      } catch {
        return false;
      }
    },

    async stat(relPath) {
      const stats = await fs.stat(resolve(relPath));
      // Floored to whole milliseconds: mtimeMs carries sub-millisecond
      // precision on some filesystems, which a round trip through an ISO
      // date string (as recorded in the crate — see crateBuilder.js) does
      // not preserve. Comparing an un-floored fresh value against the
      // floored recorded one would then always see the file as "changed",
      // even when it is not.
      return { modifiedTime: Math.floor(stats.mtimeMs), size: stats.size };
    },

    async writeFile(relPath, data) {
      const fullPath = resolve(relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, data);
    },

    async deleteFile(relPath) {
      await fs.unlink(resolve(relPath));
    },

    // Not part of the core FsAdapter interface every implementation has
    // to provide: only an adapter actually backed by the real filesystem
    // can say where a relative path really is, which is what an external
    // tool operating on the same file needs (see exiftoolWriteback.js,
    // and export.js's writeExportMetadata for a caller that treats its
    // absence as "this run mode cannot do that", rather than as an
    // error). The browser adapter has no equivalent — a File System
    // Access API handle exposes no path at all.
    absolutePathFor(relPath) {
      return resolve(relPath);
    },
  };
}
