import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import {
  loadExcludedDirectoryPatterns,
  loadExcludedFilePatterns,
  compileNamePatternMatcher,
  addExcludedFiles,
  CONFIG_FILE_NAME,
} from '../src/core/config.js';
import { createFixtureTree, removeFixtureTree } from './helpers/tempDir.js';

let currentRoot = null;

afterEach(async () => {
  if (currentRoot) {
    await removeFixtureTree(currentRoot);
    currentRoot = null;
  }
});

describe('loadExcludedDirectoryPatterns', () => {
  it('falls back to excluding dotfiles when no config file is present', async () => {
    currentRoot = await createFixtureTree({});
    const fs = createNodeFsAdapter(currentRoot);

    const patterns = await loadExcludedDirectoryPatterns(fs);

    expect(patterns).toEqual(['^\\.']);
  });

  it('reads the excludeDirectories list from a config file at the root', async () => {
    currentRoot = await createFixtureTree({
      [CONFIG_FILE_NAME]: JSON.stringify({ excludeDirectories: ['^\\.', '^HTML'] }),
    });
    const fs = createNodeFsAdapter(currentRoot);

    const patterns = await loadExcludedDirectoryPatterns(fs);

    expect(patterns).toEqual(['^\\.', '^HTML']);
  });

  it('falls back to the default when the config file is missing the field', async () => {
    currentRoot = await createFixtureTree({
      [CONFIG_FILE_NAME]: JSON.stringify({ somethingElse: true }),
    });
    const fs = createNodeFsAdapter(currentRoot);

    const patterns = await loadExcludedDirectoryPatterns(fs);

    expect(patterns).toEqual(['^\\.']);
  });
});

describe('loadExcludedFilePatterns', () => {
  it('defaults to excluding nothing when no config file is present', async () => {
    currentRoot = await createFixtureTree({});
    const fs = createNodeFsAdapter(currentRoot);

    expect(await loadExcludedFilePatterns(fs)).toEqual([]);
  });

  it('reads the excludeFiles list from a config file at the root', async () => {
    currentRoot = await createFixtureTree({
      [CONFIG_FILE_NAME]: JSON.stringify({ excludeFiles: ['^Thumbs\\.db$'] }),
    });
    const fs = createNodeFsAdapter(currentRoot);

    expect(await loadExcludedFilePatterns(fs)).toEqual(['^Thumbs\\.db$']);
  });
});

describe('compileNamePatternMatcher', () => {
  it('matches a name against any of the given patterns', () => {
    const isExcluded = compileNamePatternMatcher(['^\\.', '^HTML']);

    expect(isExcluded('.git')).toBe(true);
    expect(isExcluded('HTML')).toBe(true);
    expect(isExcluded('2025')).toBe(false);
  });
});

describe('addExcludedFiles', () => {
  it('creates a config file with the given filenames as exact-match patterns', async () => {
    currentRoot = await createFixtureTree({});
    const fs = createNodeFsAdapter(currentRoot);

    await addExcludedFiles(fs, ['stray.jpg', 'another.png']);

    const patterns = await loadExcludedFilePatterns(fs);
    const isExcluded = compileNamePatternMatcher(patterns);
    expect(isExcluded('stray.jpg')).toBe(true);
    expect(isExcluded('another.png')).toBe(true);
    expect(isExcluded('not-this-one.jpg')).toBe(false);
  });

  it('merges with, rather than replacing, an existing excludeFiles list and other config fields', async () => {
    currentRoot = await createFixtureTree({
      [CONFIG_FILE_NAME]: JSON.stringify({ excludeDirectories: ['^\\.'], excludeFiles: ['^old\\.jpg$'] }),
    });
    const fs = createNodeFsAdapter(currentRoot);

    await addExcludedFiles(fs, ['new.jpg']);

    expect(await loadExcludedDirectoryPatterns(fs)).toEqual(['^\\.']);
    const patterns = await loadExcludedFilePatterns(fs);
    const isExcluded = compileNamePatternMatcher(patterns);
    expect(isExcluded('old.jpg')).toBe(true);
    expect(isExcluded('new.jpg')).toBe(true);
  });

  it('does not duplicate a pattern already covering a filename', async () => {
    currentRoot = await createFixtureTree({});
    const fs = createNodeFsAdapter(currentRoot);

    await addExcludedFiles(fs, ['stray.jpg']);
    await addExcludedFiles(fs, ['stray.jpg']);

    const patterns = await loadExcludedFilePatterns(fs);
    expect(patterns).toHaveLength(1);
  });
});
