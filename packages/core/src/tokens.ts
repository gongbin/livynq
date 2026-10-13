import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Storage } from './storage.ts';
import type { Risk, TokenScope } from '@livynq/model';
import { LivynqError } from './errors.ts';

export type { TokenScope };
const scopeRank: Record<TokenScope, number> = { read: 0, control: 1, admin: 2 };

export interface TokenInfo {
  id: string;
  name: string;
  scope: TokenScope;
  /** Commands above this risk need a human confirmation. */
  riskLimit: Risk;
  createdAt: number;
  lastUsedAt: number | null;
}

export function scopeAllows(granted: TokenScope, required: TokenScope): boolean {
  return scopeRank[granted] >= scopeRank[required];
}

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Long-lived access tokens. Only a SHA-256 hash is stored; the raw token is shown once. */
export class TokenStore {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  create(name: string, scope: TokenScope, riskLimit?: Risk): { token: string; info: TokenInfo } {
    if (!(scope in scopeRank)) throw new LivynqError('INVALID_PARAMS', `Unknown scope ${scope}`);
    if (riskLimit !== undefined && !['low', 'medium', 'high'].includes(riskLimit)) throw new LivynqError('INVALID_PARAMS', `Unknown risk limit ${riskLimit}`);
    const token = `lvq_${randomBytes(24).toString('base64url')}`;
    const info: TokenInfo = { id: randomUUID(), name: name.trim() || 'token', scope, riskLimit: riskLimit ?? defaultRiskLimit(scope), createdAt: Date.now(), lastUsedAt: null };
    this.#storage
      .sql('INSERT INTO tokens (id, name, scope, hash, created_at, risk_limit) VALUES (?, ?, ?, ?, ?, ?)')
      .run(info.id, info.name, info.scope, hash(token), info.createdAt, info.riskLimit);
    return { token, info };
  }

  verify(raw: string | undefined): TokenInfo | undefined {
    if (!raw?.startsWith('lvq_')) return undefined;
    const row = this.#storage.sql('SELECT * FROM tokens WHERE hash = ?').get(hash(raw)) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    const now = Date.now();
    // Avoid a write per request; minute resolution is plenty for "last used".
    if (!row.last_used_at || now - Number(row.last_used_at) > 60_000) {
      this.#storage.sql('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now, String(row.id));
      row.last_used_at = now;
    }
    return toInfo(row);
  }

  list(): TokenInfo[] {
    return (this.#storage.sql('SELECT * FROM tokens ORDER BY created_at').all() as Record<string, string | number | null>[]).map(toInfo);
  }

  revoke(id: string): void {
    const result = this.#storage.sql('DELETE FROM tokens WHERE id = ?').run(id);
    if (!result.changes) throw new LivynqError('NOT_FOUND', `Token not found: ${id}`);
  }
}

/** Admins (the web UI) may do anything; agents and scripts need a human for high-risk actions. */
export function defaultRiskLimit(scope: TokenScope): Risk {
  return scope === 'admin' ? 'high' : 'medium';
}

function toInfo(row: Record<string, string | number | null>): TokenInfo {
  return {
    id: String(row.id),
    name: String(row.name),
    scope: row.scope as TokenScope,
    riskLimit: (row.risk_limit as Risk | null) ?? defaultRiskLimit(row.scope as TokenScope),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}
