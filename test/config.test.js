import { describe, it, expect, afterEach } from 'vitest';
import { createNodeFsAdapter } from '../src/adapters/nodeFs.js';
import { loadExcludedDirectoryPatterns, compileDirectoryExclusionMatcher, CONFIG_FILE_NAME } from '../src/core/config.js';
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

describe('compileDirectoryExclusionMatcher', () => {
  it('matches a directory name against any of the given patterns', () => {
    const isExcluded = compileDirectoryExclusionMatcher(['^\\.', '^HTML']);

    expect(isExcluded('.git')).toBe(true);
    expect(isExcluded('HTML')).toBe(true);
    expect(isExcluded('2025')).toBe(false);
  });
});
