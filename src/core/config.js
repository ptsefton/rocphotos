export const CONFIG_FILE_NAME = 'rocphotos.config.json';

// Directories matching any of these patterns are always excluded from the
// walk, whether or not a config file is present. Dotfiles/dot-directories
// (.git, .DS_Store-adjacent folders, editor/OS metadata) are near-universal
// noise in a real filesystem tree and should never need restating.
const DEFAULT_EXCLUDED_DIRECTORY_PATTERNS = ['^\\.'];

// Unlike directories, there is no universal "junk file" pattern worth
// excluding by default: a stray real image file sitting in an otherwise
// unremarkable directory is indistinguishable, by name alone, from a
// directory that is itself meant to be a single-folder collection. File
// exclusion is opt-in, via config, for known stray files a particular
// collection needs ignored.
const DEFAULT_EXCLUDED_FILE_PATTERNS = [];

async function loadPatternList(fsAdapter, configKey, defaultPatterns) {
  if (!(await fsAdapter.exists(CONFIG_FILE_NAME))) {
    return defaultPatterns;
  }

  const bytes = await fsAdapter.readFile(CONFIG_FILE_NAME);
  const text = new TextDecoder().decode(bytes);
  const config = JSON.parse(text);

  return Array.isArray(config[configKey]) ? config[configKey] : defaultPatterns;
}

/**
 * Loads the stop-list of directory-name regular expressions to exclude
 * from the walk, from a rocphotos.config.json file at the root of the
 * scanned directory (read through the same FsAdapter used for everything
 * else, so this works identically for the CLI and the browser SPA, which
 * cannot read files outside the directory the user granted it).
 *
 * The file, if present, is expected to look like:
 *   { "excludeDirectories": ["^\\.", "^HTML"], "excludeFiles": ["^Thumbs\\.db$"] }
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
  return loadPatternList(fsAdapter, 'excludeDirectories', DEFAULT_EXCLUDED_DIRECTORY_PATTERNS);
}

/**
 * Loads the stop-list of file-name regular expressions to exclude from
 * the walk, from the same rocphotos.config.json. A file matching one of
 * these patterns is treated as if it were not there at all: it cannot
 * trigger a crate boundary, and is not collected as an image within a
 * crate that already exists for another reason. There is no built-in
 * default (see DEFAULT_EXCLUDED_FILE_PATTERNS).
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @returns {Promise<string[]>}
 */
export async function loadExcludedFilePatterns(fsAdapter) {
  return loadPatternList(fsAdapter, 'excludeFiles', DEFAULT_EXCLUDED_FILE_PATTERNS);
}

/**
 * Compiles a list of regular-expression source strings into a single
 * predicate that tests a file or directory's own name (not its full
 * path). Used for both the directory and the file stop-list.
 *
 * @param {string[]} patterns
 * @returns {(name: string) => boolean}
 */
export function compileNamePatternMatcher(patterns) {
  const regexes = patterns.map((pattern) => new RegExp(pattern));
  return (name) => regexes.some((regex) => regex.test(name));
}

function escapeRegExp(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Adds one or more exact filenames to the config's excludeFiles list,
 * merging with (rather than overwriting) whatever is already there —
 * including other config fields such as excludeDirectories. Used to
 * record a user's choice to ignore specific stray files (see the
 * interactive resolution in bin/rocphotos.js) without requiring them to
 * hand-author a regular expression themselves.
 *
 * @param {import('./fsAdapter.js').FsAdapter} fsAdapter
 * @param {string[]} filenames
 */
export async function addExcludedFiles(fsAdapter, filenames) {
  const existing = (await fsAdapter.exists(CONFIG_FILE_NAME))
    ? JSON.parse(new TextDecoder().decode(await fsAdapter.readFile(CONFIG_FILE_NAME)))
    : {};

  const existingPatterns = Array.isArray(existing.excludeFiles) ? existing.excludeFiles : [];
  const newPatterns = filenames.map((name) => `^${escapeRegExp(name)}$`);
  const excludeFiles = [...new Set([...existingPatterns, ...newPatterns])];

  const updated = { ...existing, excludeFiles };
  await fsAdapter.writeFile(CONFIG_FILE_NAME, JSON.stringify(updated, null, 2));
}
