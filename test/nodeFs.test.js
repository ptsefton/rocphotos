import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('stat', () => {
  it('returns an integer modifiedTime (whole milliseconds) and the correct size', async () => {
    currentRoot = await createFixtureTree({ 'photo.jpg': 'hello world' });
    const fs = createNodeFsAdapter(currentRoot);

    const stats = await fs.stat('photo.jpg');

    expect(Number.isInteger(stats.modifiedTime)).toBe(true);
    expect(stats.size).toEqual('hello world'.length);
  });

  it('returns a modifiedTime that is stable across repeated stat calls on an unchanged file', async () => {
    // Guards against the mtime round-trip bug: a fractional-millisecond
    // mtimeMs, stored via an ISO date string and re-compared against a
    // fresh, un-floored stat, would make an unchanged file look "newer"
    // than its own recorded modification time forever.
    currentRoot = await createFixtureTree({ 'photo.jpg': 'hello world' });
    const fs = createNodeFsAdapter(currentRoot);

    const first = await fs.stat('photo.jpg');
    const second = await fs.stat('photo.jpg');

    expect(second.modifiedTime).toEqual(first.modifiedTime);
    expect(second.modifiedTime <= first.modifiedTime).toBe(true);
  });
});
