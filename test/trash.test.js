import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { trashPathFor, moveToTrash, TRASH_DIR_NAME } from '../src/core/trash.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('trashPathFor', () => {
  it('preserves the original collection-relative path under the trash directory', () => {
    expect(trashPathFor('2025/03/10/photo.jpg')).toEqual(`${TRASH_DIR_NAME}/2025/03/10/photo.jpg`);
  });

  it('keeps two same-named files from different sub-collections apart', () => {
    expect(trashPathFor('2024/02/01/photo.jpg')).not.toEqual(trashPathFor('2025/03/10/photo.jpg'));
  });
});

describe('moveToTrash', () => {
  it('copies the file to its trash path and removes the original', async () => {
    currentRoot = await createFixtureTree({ '2025': { '03': { '10': { 'photo.jpg': 'bytes' } } } });
    const fsAdapter = createNodeFsAdapter(currentRoot);

    const destination = await moveToTrash(fsAdapter, '2025/03/10/photo.jpg');

    expect(destination).toEqual(`${TRASH_DIR_NAME}/2025/03/10/photo.jpg`);
    expect(await fsAdapter.exists('2025/03/10/photo.jpg')).toBe(false);
    expect(await fsAdapter.exists(destination)).toBe(true);
    expect(new TextDecoder().decode(await fsAdapter.readFile(destination))).toEqual('bytes');
  });
});
