/**
 * Minimal filesystem adapter interface used by all core RO-Crate
 * operations (directory walking, EXIF extraction, crate construction).
 * All paths are POSIX-style and relative to the adapter's root directory.
 *
 * Implementations exist for Node.js (full, unrestricted filesystem access,
 * used by the CLI and by tests) and for the browser (File System Access
 * API). Core logic depends only on this interface, never on either
 * implementation directly, so it is testable without a browser.
 *
 * @typedef {Object} FsAdapter
 * @property {(dirPath: string) => Promise<Array<{name: string, isDirectory: boolean}>>} readDir
 * @property {(filePath: string) => Promise<Uint8Array>} readFile
 * @property {(filePath: string) => Promise<boolean>} exists
 * @property {(filePath: string) => Promise<{modifiedTime: number, size: number}>} stat - modifiedTime is epoch milliseconds
 * @property {(filePath: string, data: Uint8Array|string) => Promise<void>} writeFile
 * @property {(filePath: string) => Promise<void>} deleteFile
 */

export {};
