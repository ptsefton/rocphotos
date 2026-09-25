import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { findCrateDirectories, collectImages, walkCollection, detectLooseRootImages } from '../src/core/walker.js';
import { compileNamePatternMatcher } from '../src/core/config.js';
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

  it('ignores its own _rocphotos housekeeping directory (trash, etc.) when looking for crate boundaries', async () => {
    currentRoot = await createFixtureTree({
      _rocphotos: { trash: { '2024': { '01': { 'deleted.jpg': '' } } } },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const crateDirs = await findCrateDirectories(fs);

    expect(crateDirs).toEqual([]);
  });

  it('ignores its own _exports directory, so an exported album is never mistaken for a new sub-collection', async () => {
    currentRoot = await createFixtureTree({
      _exports: { 'road-trip': { '2024': { '01': { 'photo.jpg': '' } } } },
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
    const isExcluded = compileNamePatternMatcher(['^\\.', '^HTML']);
    const crateDirs = await findCrateDirectories(fs, '', isExcluded);

    expect(crateDirs).toEqual([]);
  });

  it('does not let an excluded stray file at the root trigger a root-wide crate boundary', async () => {
    // Mirrors real-world junk: a few loose images sitting directly in the
    // collection root, alongside proper year/month/day subdirectories.
    // Left uncontrolled, the loose file would make the whole root the
    // sole crate and hide every subdirectory crate beneath it.
    currentRoot = await createFixtureTree({
      'stray.jp2': '',
      '2024': { '01': { '09': { 'photo.jpg': '' } } },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const isExcludedFile = compileNamePatternMatcher(['^stray\\.jp2$']);
    const crateDirs = await findCrateDirectories(fs, '', undefined, isExcludedFile);

    expect(crateDirs).toEqual(['2024/01/09']);
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
    const isExcluded = compileNamePatternMatcher(['^\\.', '^HTML']);
    const images = await collectImages(fs, '2024', isExcluded);

    expect(images).toEqual(['photo1.jpg']);
  });
});

describe('detectLooseRootImages', () => {
  it('reports loose images when the root has both images and subdirectories', async () => {
    currentRoot = await createFixtureTree({
      'stray1.jpg': '',
      'stray2.jp2': '',
      '2024': { '01': { '09': { 'photo.jpg': '' } } },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const loose = (await detectLooseRootImages(fs)).sort();

    expect(loose).toEqual(['stray1.jpg', 'stray2.jp2']);
  });

  it('reports nothing when the root holding images directly is the only content (a legitimate single-folder collection)', async () => {
    currentRoot = await createFixtureTree({
      'photo1.jpg': '',
      'photo2.jpg': '',
    });

    const fs = createNodeFsAdapter(currentRoot);
    expect(await detectLooseRootImages(fs)).toEqual([]);
  });

  it('reports nothing when the root has no images at all', async () => {
    currentRoot = await createFixtureTree({
      '2024': { '01': { '09': { 'photo.jpg': '' } } },
    });

    const fs = createNodeFsAdapter(currentRoot);
    expect(await detectLooseRootImages(fs)).toEqual([]);
  });

  it('does not count an excluded directory as a real subdirectory, so a stray image alongside only a dotfile is not flagged as ambiguous', async () => {
    currentRoot = await createFixtureTree({
      'photo.jpg': '',
      '.git': { 'config': '' },
    });

    const fs = createNodeFsAdapter(currentRoot);
    expect(await detectLooseRootImages(fs)).toEqual([]);
  });

  it('does not report a file already excluded by the caller-supplied file pattern', async () => {
    currentRoot = await createFixtureTree({
      'stray.jpg': '',
      '2024': { '01': { '09': { 'photo.jpg': '' } } },
    });

    const fs = createNodeFsAdapter(currentRoot);
    const isExcludedFile = compileNamePatternMatcher(['^stray\\.jpg$']);
    expect(await detectLooseRootImages(fs, undefined, isExcludedFile)).toEqual([]);
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
