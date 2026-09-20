import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { findCrateDirectories, collectImages, walkCollection } from '../src/core/walker.js';
import { compileDirectoryExclusionMatcher } from '../src/core/config.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('findCrateDirectories', () => {
  it('treats the first directory found containing an image as a crate boundary', async () => {
    currentRoot = await createFixtureTree({
      '2024': {
        'photo1.jpg': '',
        sub: { 'photo2.jpg': '' },
      },
      '2025': {
        vacation: { 'photo3.png': '' },
      },
      'notes.txt': '',
      'empty-dir': {},
    });

    const fs = createNodeFsAdapter(currentRoot);
    const crateDirs = (await findCrateDirectories(fs)).sort();

    expect(crateDirs).toEqual(['2024', '2025/vacation']);
  });

  it('treats the root itself as the sole crate when it directly contains an image', async () => {
    currentRoot = await createFixtureTree({
      'photo.jpg': '',
      sub: { 'photo2.jpg': '' },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const crateDirs = await findCrateDirectories(fs);

    expect(crateDirs).toEqual(['']);
  });

  it('returns no crates when no image files exist anywhere', async () => {
    currentRoot = await createFixtureTree({
      docs: { 'readme.txt': '' },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const crateDirs = await findCrateDirectories(fs);

    expect(crateDirs).toEqual([]);
  });

  it('ignores its own generated thumbnails directory when looking for crate boundaries', async () => {
    currentRoot = await createFixtureTree({
      cache: { thumbnails: { 'stray.jpg': '' } },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const crateDirs = await findCrateDirectories(fs);

    expect(crateDirs).toEqual([]);
  });

  it('honours a caller-supplied exclusion pattern, so a stray generated-gallery export is not mistaken for a crate', async () => {
    // Mirrors real-world junk: a day folder with no photos of its own,
    // whose only images live inside an old static-gallery export.
    currentRoot = await createFixtureTree({
      '20060102': {
        'INDEX.HTM': '',
        HTML: { ICON: { 'thumb1.jpg': '', 'thumb2.jpg': '' } },
      },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const isExcluded = compileDirectoryExclusionMatcher(['^\\.', '^HTML']);
    const crateDirs = await findCrateDirectories(fs, '', isExcluded);

    expect(crateDirs).toEqual([]);
  });
});

describe('collectImages', () => {
  it('absorbs images at any depth beneath a crate directory', async () => {
    currentRoot = await createFixtureTree({
      '2024': {
        'photo1.jpg': '',
        sub: { deeper: { 'photo2.jpg': '' } },
        'notes.txt': '',
      },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const images = (await collectImages(fs, '2024')).sort();

    expect(images).toEqual(['photo1.jpg', 'sub/deeper/photo2.jpg']);
  });

  it('excludes the thumbnails cache directory from the image list', async () => {
    currentRoot = await createFixtureTree({
      '2024': {
        'photo1.jpg': '',
        thumbnails: { 'photo1.jpg.thumb.jpg': '' },
      },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const images = await collectImages(fs, '2024');

    expect(images).toEqual(['photo1.jpg']);
  });

  it('excludes a caller-supplied pattern at any depth, not just at the top level', async () => {
    currentRoot = await createFixtureTree({
      '2024': {
        'photo1.jpg': '',
        nested: { HTML: { ICON: { 'thumb1.jpg': '' } } },
      },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const isExcluded = compileDirectoryExclusionMatcher(['^\\.', '^HTML']);
    const images = await collectImages(fs, '2024', isExcluded);

    expect(images).toEqual(['photo1.jpg']);
  });
});

describe('walkCollection', () => {
  it('reports each crate directory together with its images', async () => {
    currentRoot = await createFixtureTree({
      '2024': { 'photo1.jpg': '' },
      '2025': { vacation: { 'photo2.jpg': '', 'photo3.jpg': '' } },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const { crateDirs } = await walkCollection(fs);
    crateDirs.sort((a, b) => a.path.localeCompare(b.path));

    expect(crateDirs).toEqual([
      { path: '2024', images: ['photo1.jpg'] },
      { path: '2025/vacation', images: expect.arrayContaining(['photo2.jpg', 'photo3.jpg']) },
    ]);
  });
});
