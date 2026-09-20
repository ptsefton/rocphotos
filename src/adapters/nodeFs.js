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

    async writeFile(relPath, data) {
      const fullPath = resolve(relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, data);
    },
  };
}
