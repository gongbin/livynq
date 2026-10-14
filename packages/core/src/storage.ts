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
  `
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_triggered INTEGER
  );
  CREATE TABLE automation_versions (
    automation_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    config TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (automation_id, version)
  );
  CREATE TABLE automation_traces (
    run_id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    trace TEXT NOT NULL
  );
  CREATE INDEX automation_traces_lookup ON automation_traces (automation_id, started_at);
  `,
  `
  CREATE TABLE imports (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    report TEXT NOT NULL,
    undo TEXT NOT NULL,
    reverted_at INTEGER
  );
  `,
  `
  ALTER TABLE tokens ADD COLUMN risk_limit TEXT;
  CREATE TABLE confirmations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    device_id TEXT NOT NULL,
    endpoint_id INTEGER NOT NULL,
    capability TEXT NOT NULL,
    command TEXT NOT NULL,
    params TEXT NOT NULL,
    risk TEXT NOT NULL,
    summary TEXT NOT NULL,
    decided_by TEXT,
    decided_at INTEGER,
    error TEXT
  );
  CREATE INDEX confirmations_status ON confirmations (status, created_at);
  `,
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE rooms ADD COLUMN level_id TEXT;
  ALTER TABLE rooms ADD COLUMN polygon TEXT;
  ALTER TABLE rooms ADD COLUMN color TEXT;
  CREATE TABLE levels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    elevation REAL NOT NULL DEFAULT 0,
    background TEXT
  );
  CREATE TABLE scene_documents (
    level_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    allowed_rooms TEXT,
    risk_limit TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE UNIQUE INDEX users_username ON users (username COLLATE NOCASE);
  ALTER TABLE tokens ADD COLUMN user_id TEXT;
  ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'api';
  ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
  CREATE INDEX tokens_user ON tokens (user_id);
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
