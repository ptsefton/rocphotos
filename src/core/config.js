export const CONFIG_FILE_NAME = 'rocphotos.config.json';

// Directories matching any of these patterns are always excluded from the
// walk, whether or not a config file is present. Dotfiles/dot-directories
// (.git, .DS_Store-adjacent folders, editor/OS metadata) are near-universal
// noise in a real filesystem tree and should never need restating.
const DEFAULT_EXCLUDED_DIRECTORY_PATTERNS = ['^\\.'];

/**
 * Loads the stop-list of directory-name regular expressions to exclude
 * from the walk, from a rocphotos.config.json file at the root of the
 * scanned directory (read through the same FsAdapter used for everything
 * else, so this works identically for the CLI and the browser SPA, which
 * cannot read files outside the directory the user granted it).
 *
 * The file, if present, is expected to look like:
 *   { "excludeDirectories": ["^\\.", "^HTML"] }
 *
 * Its list replaces the built-in default entirely (rather than adding to
 * it), so a config author who still wants dotfiles excluded restates that
 * pattern explicitly; this keeps the effective stop-list fully visible in
 * one place instead of split between code and config.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @returns {Promise<string[]>}
 */
export async function loadExcludedDirectoryPatterns(fsAdapter) {
  if (!(await fsAdapter.exists(CONFIG_FILE_NAME))) {
    return DEFAULT_EXCLUDED_DIRECTORY_PATTERNS;
  }

  const bytes = await fsAdapter.readFile(CONFIG_FILE_NAME);
  const text = new TextDecoder().decode(bytes);
  const config = JSON.parse(text);

  return Array.isArray(config.excludeDirectories)
    ? config.excludeDirectories
    : DEFAULT_EXCLUDED_DIRECTORY_PATTERNS;
}

/**
 * Compiles a list of regular-expression source strings into a single
 * predicate that tests a directory's own name (not its full path).
 *
 * @param {string[]} patterns
 * @returns {(name: string) => boolean}
 */
export function compileDirectoryExclusionMatcher(patterns) {
  const regexes = patterns.map((pattern) => new RegExp(pattern));
  return (name) => regexes.some((regex) => regex.test(name));
}
