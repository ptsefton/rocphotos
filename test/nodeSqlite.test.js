import { describe, it, expect } from 'vitest';
import { openNodeSqlite } from '../src/adapters/nodeSqlite.js';

describe('openNodeSqlite', () => {
  it('supports exec, run, all, and get against an in-memory database', () => {
    const db = openNodeSqlite(':memory:');
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT)');
      db.run('INSERT INTO t (id, name) VALUES (?, ?)', ['a', 'Alice']);
      db.run('INSERT INTO t (id, name) VALUES (?, ?)', ['b', 'Bob']);

      expect(db.all('SELECT * FROM t ORDER BY id')).toEqual([
        { id: 'a', name: 'Alice' },
        { id: 'b', name: 'Bob' },
      ]);
      expect(db.get('SELECT * FROM t WHERE id = ?', ['b'])).toEqual({ id: 'b', name: 'Bob' });
      expect(db.get('SELECT * FROM t WHERE id = ?', ['missing'])).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
