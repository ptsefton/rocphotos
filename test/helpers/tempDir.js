import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates a temporary directory and populates it from a plain object tree,
 * where string values are file contents and object values are
 * subdirectories. Returns the temp directory's absolute path.
 *
 * @param {Object} tree
 * @returns {Promise<string>}
 */
export async function createFixtureTree(tree) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rocphotos-test-'));
  await writeTree(root, tree);
  return root;
}

async function writeTree(dirPath, tree) {
  for (const [name, value] of Object.entries(tree)) {
    const entryPath = path.join(dirPath, name);
    if (typeof value === 'string') {
      await fs.writeFile(entryPath, value);
    } else {
      await fs.mkdir(entryPath, { recursive: true });
      await writeTree(entryPath, value);
    }
  }
}

export async function removeFixtureTree(root) {
  await fs.rm(root, { recursive: true, force: true });
}
