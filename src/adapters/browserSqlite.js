import initSqlJs from 'sql.js';

function rowsFrom(stmt) {
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  return rows;
}

/**
 * Creates a SqliteDriver (see nodeSqlite.js's SqliteDriver typedef) backed
 * by sql.js (SQLite compiled to WASM), for use anywhere Node's built-in
 * node:sqlite is not available — chiefly the browser SPA, since it has no
 * access to node:sqlite at all. Reads and writes the exact same physical
 * SQLite file format node:sqlite does (there is nothing driver-specific
 * in schema.js), so a collection indexed via the CLI opens here
 * unmodified, and a database exported from here (see the returned
 * `export` function) opens equally well via `openNodeSqlite`.
 *
 * @param {Uint8Array|null} bytes - existing database file contents, or null/undefined for a fresh, empty database
 * @param {{locateFile?: (file: string) => string}} [options] - passed through to sql.js's initSqlJs. Node resolves its own .wasm file automatically without this; the browser bundle supplies it to point at the bundled asset (see src/main.js).
 * @returns {Promise<{driver: import('./nodeSqlite.js').SqliteDriver, export: () => Uint8Array}>}
 */
export async function openBrowserSqlite(bytes, options = {}) {
  const SQL = await initSqlJs(options);
  const db = new SQL.Database(bytes ?? undefined);

  const driver = {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      db.run(sql, params);
      return { changes: db.getRowsModified(), lastInsertRowid: undefined };
    },
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        return rowsFrom(stmt);
      } finally {
        stmt.free();
      }
    },
    get(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
    close() {
      db.close();
    },
  };

  return { driver, export: () => db.export() };
}
