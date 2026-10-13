import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Ordered schema migrations. Never edit a shipped migration; append a new one. */
const migrations: string[] = [
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE endpoint_ids (
    device_id TEXT NOT NULL,
    key TEXT NOT NULL,
    endpoint_id INTEGER NOT NULL,
    PRIMARY KEY (device_id, key)
  );
  CREATE TABLE state_current (
    device_id TEXT NOT NULL,
    endpoint_id INTEGER NOT NULL,
    capability TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (device_id, endpoint_id, capability, attribute)
  );
  CREATE TABLE state_history (
    device_id TEXT NOT NULL,
    endpoint_id INTEGER NOT NULL,
    capability TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX state_history_lookup ON state_history (device_id, endpoint_id, capability, attribute, ts);
  CREATE INDEX state_history_ts ON state_history (ts);
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE entities (
    entity_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    endpoint_id INTEGER NOT NULL,
    UNIQUE (device_id, endpoint_id)
  );
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE command_log (
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    endpoint_id INTEGER NOT NULL,
    capability TEXT NOT NULL,
    command TEXT NOT NULL,
    params TEXT,
    ok INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX command_log_ts ON command_log (ts);
  `,
];

export class Storage {
  readonly db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  #migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let i = version; i < migrations.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(migrations[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** Cached prepared statement. */
  sql(query: string): StatementSync {
    let stmt = this.#statements.get(query);
    if (!stmt) {
      stmt = this.db.prepare(query);
      this.#statements.set(query, stmt);
    }
    return stmt;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.#statements.clear();
    this.db.close();
  }
}
