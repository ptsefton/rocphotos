import { DatabaseSync } from 'node:sqlite';

/**
 * Minimal SQLite driver interface used by the core db store. Implemented
 * here with Node's built-in node:sqlite module (no native dependency);
 * a future browser counterpart (sql.js) would implement the same shape
 * against an in-memory database serialized to/from a file via FsAdapter.
 *
 * @typedef {Object} SqliteDriver
 * @property {(sql: string) => void} exec
 * @property {(sql: string, params?: any[]) => {changes: number, lastInsertRowid: number|bigint}} run
 * @property {(sql: string, params?: any[]) => object[]} all
 * @property {(sql: string, params?: any[]) => object|undefined} get
 * @property {() => void} close
 */

/**
 * Opens (creating if necessary) a SQLite database file at `filePath`.
 *
 * @param {string} filePath absolute path to the .sqlite file
 * @returns {SqliteDriver}
 */
export function openNodeSqlite(filePath) {
  const db = new DatabaseSync(filePath);

  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    close() {
      db.close();
    },
  };
}
