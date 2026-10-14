import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Storage } from './storage.ts';
import type { Risk, TokenScope } from '@livynq/model';
import { LivynqError } from './errors.ts';

export type { TokenScope };
const scopeRank: Record<TokenScope, number> = { read: 0, control: 1, admin: 2 };

export type TokenKind = 'api' | 'session';

export interface TokenInfo {
  id: string;
  name: string;
  scope: TokenScope;
  /** Commands above this risk need a human confirmation. */
  riskLimit: Risk;
  createdAt: number;
  lastUsedAt: number | null;
  /** The user who owns the token (sessions always have one; older API tokens have none). */
  userId: string | null;
  kind: TokenKind;
  /** Sessions expire (sliding); API tokens don't. */
  expiresAt: number | null;
}

export function scopeAllows(granted: TokenScope, required: TokenScope): boolean {
  return scopeRank[granted] >= scopeRank[required];
}

export const minScope = (a: TokenScope, b: TokenScope): TokenScope => (scopeRank[a] <= scopeRank[b] ? a : b);

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

export const SESSION_TTL_MS = 30 * 24 * 3600_000;

/** Access tokens and sign-in sessions. Only a SHA-256 hash is stored; the raw token is shown once. */
export class TokenStore {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  create(name: string, scope: TokenScope, riskLimit?: Risk, options: { userId?: string | null; kind?: TokenKind; ttlMs?: number } = {}): { token: string; info: TokenInfo } {
    if (!(scope in scopeRank)) throw new LivynqError('INVALID_PARAMS', `Unknown scope ${scope}`);
    if (riskLimit !== undefined && !['low', 'medium', 'high'].includes(riskLimit)) throw new LivynqError('INVALID_PARAMS', `Unknown risk limit ${riskLimit}`);
    const token = `lvq_${randomBytes(24).toString('base64url')}`;
    const kind = options.kind ?? 'api';
    const now = Date.now();
    const info: TokenInfo = {
      id: randomUUID(),
      name: name.trim() || 'token',
      scope,
      riskLimit: riskLimit ?? defaultRiskLimit(scope),
      createdAt: now,
      lastUsedAt: null,
      userId: options.userId ?? null,
      kind,
      expiresAt: kind === 'session' ? now + (options.ttlMs ?? SESSION_TTL_MS) : null,
    };
    this.#storage
      .sql('INSERT INTO tokens (id, name, scope, hash, created_at, risk_limit, user_id, kind, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(info.id, info.name, info.scope, hash(token), info.createdAt, info.riskLimit, info.userId, info.kind, info.expiresAt);
    return { token, info };
  }

  verify(raw: string | undefined): TokenInfo | undefined {
    if (!raw?.startsWith('lvq_')) return undefined;
    const row = this.#storage.sql('SELECT * FROM tokens WHERE hash = ?').get(hash(raw)) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    const now = Date.now();
    if (row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) <= now) {
      this.#storage.sql('DELETE FROM tokens WHERE id = ?').run(String(row.id));
      return undefined;
    }
    // Avoid a write per request; minute resolution is plenty for "last used".
    if (!row.last_used_at || now - Number(row.last_used_at) > 60_000) {
      // Sessions slide: in use = stays signed in.
      const expires = row.kind === 'session' ? now + SESSION_TTL_MS : row.expires_at;
      this.#storage.sql('UPDATE tokens SET last_used_at = ?, expires_at = ? WHERE id = ?').run(now, expires ?? null, String(row.id));
      row.last_used_at = now;
      row.expires_at = expires ?? null;
    }
    return toInfo(row);
  }

  get(id: string): TokenInfo | undefined {
    const row = this.#storage.sql('SELECT * FROM tokens WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return row ? toInfo(row) : undefined;
  }

  list(filter: { kind?: TokenKind; userId?: string } = {}): TokenInfo[] {
    return (this.#storage.sql('SELECT * FROM tokens ORDER BY created_at').all() as Record<string, string | number | null>[])
      .map(toInfo)
      .filter((t) => (filter.kind === undefined || t.kind === filter.kind) && (filter.userId === undefined || t.userId === filter.userId));
  }

  revoke(id: string): void {
    const result = this.#storage.sql('DELETE FROM tokens WHERE id = ?').run(id);
    if (!result.changes) throw new LivynqError('NOT_FOUND', `Token not found: ${id}`);
  }

  /** Signs a user out (sessions) or removes everything they own. Returns how many were removed. */
  revokeForUser(userId: string, kind?: TokenKind): number {
    const r = kind
      ? this.#storage.sql('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(userId, kind)
      : this.#storage.sql('DELETE FROM tokens WHERE user_id = ?').run(userId);
    return Number(r.changes);
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
    userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
    kind: (row.kind as TokenKind | null) ?? 'api',
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
  };
}
