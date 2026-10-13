import type { Storage } from './storage.ts';
import type { EventBus } from './event-bus.ts';

/** Small JSON key/value store for hub-wide preferences (shared by every UI client, unlike browser storage). */
export class Settings {
  readonly #storage: Storage;
  readonly #bus: EventBus;

  constructor(storage: Storage, bus: EventBus) {
    this.#storage = storage;
    this.#bus = bus;
  }

  get<T>(key: string, fallback: T): T {
    const row = this.#storage.sql('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  set<T>(key: string, value: T): T {
    this.#storage
      .sql('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
    this.#bus.emit('settings', { key, value });
    return value;
  }
}
