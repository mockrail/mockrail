import { createRequire } from 'node:module';
import { fromJson, toJson } from '../shared/json.js';
import { MemoryStore, type StoreRecord, type StoreSnapshot } from './store.js';

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * Write-through SQLite store built on Node's built-in `node:sqlite`.
 * Reads are served from memory; every write is persisted, so state survives restarts.
 */
export class SqliteStore extends MemoryStore {
  private readonly db: SqliteDatabase;
  private readonly upsert: SqliteStatement;
  private readonly remove: SqliteStatement;

  constructor(path: string) {
    super();
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
    this.db = new DatabaseSync(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (collection, id))',
    );
    this.upsert = this.db.prepare(
      'INSERT INTO records (collection, id, body) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body',
    );
    this.remove = this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?');

    const rows = this.db.prepare('SELECT collection, body FROM records').all() as { collection: string; body: string }[];
    const collections: Record<string, StoreRecord[]> = {};
    for (const row of rows) {
      (collections[row.collection] ??= []).push(fromJson<StoreRecord>(row.body));
    }
    super.restore({ collections });
  }

  override put<T extends StoreRecord>(collection: string, record: T): T {
    super.put(collection, record);
    this.upsert.run(collection, record.id, toJson(record));
    return record;
  }

  override delete(collection: string, id: string): boolean {
    const removed = super.delete(collection, id);
    this.remove.run(collection, id);
    return removed;
  }

  override restore(snapshot: StoreSnapshot): void {
    super.restore(snapshot);
    this.db.exec('DELETE FROM records');
    for (const [name, records] of Object.entries(snapshot.collections)) {
      for (const record of records) this.upsert.run(name, record.id, toJson(record));
    }
  }

  override clear(): void {
    super.clear();
    this.db.exec('DELETE FROM records');
  }

  override close(): void {
    this.db.close();
  }
}
