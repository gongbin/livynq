import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Device, Risk, TokenScope } from '@livynq/model';
import { LivynqError } from './errors.ts';
import type { Storage } from './storage.ts';
import { minScope, type TokenInfo } from './tokens.ts';

/**
 * People who sign in to the web UI. Roles map to token scopes:
 *   owner / admin → admin, member → control, guest → control limited to some rooms, low risk only
 * and never able to queue a confirmation (no unlocking doors, even "with approval").
 * Exactly one owner exists once the first account is created; ownership moves only by transfer.
 */

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export const ROLES: Role[] = ['owner', 'admin', 'member', 'guest'];

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** null = every room */
  allowedRooms: string[] | null;
  /** Optional cap on command risk; guests are always "low". */
  riskLimit: Risk | null;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** "scrypt$N$r$p$salt$hash" (base64) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function checkPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8) throw new LivynqError('INVALID_PARAMS', 'The password must have at least 8 characters');
  if (password.length > 200) throw new LivynqError('INVALID_PARAMS', 'The password is too long');
  return password;
}

export function roleScope(role: Role): TokenScope {
  return role === 'owner' || role === 'admin' ? 'admin' : 'control';
}

const USERNAME = /^[\p{L}\p{N}._@-]{2,40}$/u;
// A precomputed hash for unknown user names, so failed logins take the same time.
let dummyHash: Promise<string> | undefined;

type Row = Record<string, string | number | null>;

export class UserStore {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  count(): number {
    return Number((this.#storage.sql('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
  }

  list(): User[] {
    return (this.#storage.sql('SELECT * FROM users ORDER BY created_at').all() as Row[]).map(toUser);
  }

  get(id: string): User | undefined {
    const row = this.#storage.sql('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  require(id: string): User {
    const u = this.get(id);
    if (!u) throw new LivynqError('NOT_FOUND', `User not found: ${id}`);
    return u;
  }

  findByUsername(username: string): User | undefined {
    const row = this.#storage.sql('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username.trim()) as Row | undefined;
    return row ? toUser(row) : undefined;
  }

  owner(): User | undefined {
    return this.list().find((u) => u.role === 'owner');
  }

  async create(input: { username: string; displayName?: string; password: string; role: Role; allowedRooms?: string[] | null; riskLimit?: Risk | null }): Promise<User> {
    const username = input.username.trim();
    if (!USERNAME.test(username)) throw new LivynqError('INVALID_PARAMS', 'The user name needs 2–40 letters, digits or . _ - @');
    if (!ROLES.includes(input.role)) throw new LivynqError('INVALID_PARAMS', `Unknown role ${String(input.role)}`);
    if (input.role === 'owner' && this.owner()) throw new LivynqError('CONFLICT', 'There already is an owner; transfer ownership instead');
    if (input.role !== 'owner' && !this.owner()) throw new LivynqError('INVALID_PARAMS', 'The first account must be the owner');
    if (this.findByUsername(username)) throw new LivynqError('CONFLICT', `The user name ${username} is taken`);
    const passwordHash = await hashPassword(checkPassword(input.password));
    const user: User = {
      id: randomUUID(),
      username,
      displayName: (input.displayName ?? '').trim().slice(0, 60) || username,
      role: input.role,
      allowedRooms: input.role === 'owner' || input.role === 'admin' ? null : normalizeRooms(input.allowedRooms),
      riskLimit: input.role === 'guest' ? 'low' : (input.riskLimit ?? null),
      disabled: false,
      createdAt: Date.now(),
      lastLoginAt: null,
    };
    this.#storage
      .sql('INSERT INTO users (id, username, display_name, role, password_hash, allowed_rooms, risk_limit, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(user.id, user.username, user.displayName, user.role, passwordHash, user.allowedRooms ? JSON.stringify(user.allowedRooms) : null, user.riskLimit, user.createdAt);
    return user;
  }

  update(id: string, patch: { displayName?: string; role?: Role; allowedRooms?: string[] | null; riskLimit?: Risk | null; disabled?: boolean }): User {
    const u = this.require(id);
    if (patch.role !== undefined && !ROLES.includes(patch.role)) throw new LivynqError('INVALID_PARAMS', `Unknown role ${String(patch.role)}`);
    if (u.role === 'owner' && ((patch.role && patch.role !== 'owner') || patch.disabled)) throw new LivynqError('FORBIDDEN', 'The owner cannot be demoted or disabled; transfer ownership first');
    if (patch.role === 'owner' && u.role !== 'owner') throw new LivynqError('FORBIDDEN', 'Use "transfer ownership" to make someone the owner');
    const role = patch.role ?? u.role;
    const privileged = role === 'owner' || role === 'admin';
    const next: User = {
      ...u,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim().slice(0, 60) || u.username } : {}),
      role,
      allowedRooms: privileged ? null : patch.allowedRooms !== undefined ? normalizeRooms(patch.allowedRooms) : u.allowedRooms,
      riskLimit: role === 'guest' ? 'low' : patch.riskLimit !== undefined ? patch.riskLimit : role !== u.role && u.role === 'guest' ? null : u.riskLimit,
      disabled: patch.disabled ?? u.disabled,
    };
    this.#storage
      .sql('UPDATE users SET display_name = ?, role = ?, allowed_rooms = ?, risk_limit = ?, disabled = ? WHERE id = ?')
      .run(next.displayName, next.role, next.allowedRooms ? JSON.stringify(next.allowedRooms) : null, next.riskLimit, next.disabled ? 1 : 0, id);
    return next;
  }

  async setPassword(id: string, password: string): Promise<void> {
    this.require(id);
    this.#storage.sql('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(checkPassword(password)), id);
  }

  /** The user for a correct user name + password (disabled accounts fail like wrong passwords). */
  async authenticate(username: string, password: string): Promise<User | undefined> {
    const row = this.#storage.sql('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim()) as Row | undefined;
    if (!row) {
      dummyHash ??= hashPassword('not-a-real-password');
      await verifyPassword(String(password), await dummyHash);
      return undefined;
    }
    const ok = await verifyPassword(String(password), String(row.password_hash));
    if (!ok || Number(row.disabled)) return undefined;
    const now = Date.now();
    this.#storage.sql('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, String(row.id));
    return { ...toUser(row), lastLoginAt: now };
  }

  markLogin(id: string): void {
    this.#storage.sql('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
  }

  async checkOwnPassword(id: string, password: string): Promise<boolean> {
    const row = this.#storage.sql('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string } | undefined;
    return row ? verifyPassword(password, row.password_hash) : false;
  }

  remove(id: string): void {
    const u = this.require(id);
    if (u.role === 'owner') throw new LivynqError('FORBIDDEN', 'The owner cannot be deleted; transfer ownership first');
    this.#storage.sql('DELETE FROM users WHERE id = ?').run(id);
  }

  transferOwnership(fromId: string, toId: string): { from: User; to: User } {
    const from = this.require(fromId);
    const to = this.require(toId);
    if (from.role !== 'owner') throw new LivynqError('FORBIDDEN', 'Only the owner can transfer ownership');
    if (to.id === from.id) throw new LivynqError('INVALID_PARAMS', 'Choose another user');
    if (to.disabled) throw new LivynqError('INVALID_PARAMS', 'Enable the account first');
    this.#storage.transaction(() => {
      this.#storage.sql("UPDATE users SET role = 'admin' WHERE id = ?").run(from.id);
      this.#storage.sql("UPDATE users SET role = 'owner', allowed_rooms = NULL, risk_limit = NULL WHERE id = ?").run(to.id);
    });
    return { from: this.require(from.id), to: this.require(to.id) };
  }

  /** Removes deleted rooms from every restriction (so a guest is not silently granted everything). */
  pruneRooms(existing: Set<string>): void {
    for (const u of this.list()) {
      if (!u.allowedRooms) continue;
      const kept = u.allowedRooms.filter((r) => existing.has(r));
      if (kept.length !== u.allowedRooms.length) this.#storage.sql('UPDATE users SET allowed_rooms = ? WHERE id = ?').run(JSON.stringify(kept), u.id);
    }
  }
}

function normalizeRooms(rooms: string[] | null | undefined): string[] | null {
  if (rooms === null || rooms === undefined) return null;
  if (!Array.isArray(rooms)) throw new LivynqError('INVALID_PARAMS', 'allowedRooms must be a list of room ids or null');
  return [...new Set(rooms.map(String))];
}

function toUser(row: Row): User {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role as Role,
    allowedRooms: row.allowed_rooms ? (JSON.parse(String(row.allowed_rooms)) as string[]) : null,
    riskLimit: (row.risk_limit as Risk | null) ?? null,
    disabled: Boolean(Number(row.disabled)),
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
  };
}

// ---------------------------------------------------------------- per-request access

export interface Access {
  token: TokenInfo;
  user: User | null;
  /** Effective scope: the token's, capped by the user's role */
  scope: TokenScope;
  riskLimit: Risk;
  /** null = all rooms; otherwise only devices in these rooms are visible */
  rooms: Set<string> | null;
  /** Guests can't queue confirmations: over-limit commands are refused outright. */
  canRequestApproval: boolean;
  /** Guests don't see automations. */
  automations: boolean;
  /** Audit name: the user name for sessions, the token name for API tokens */
  label: string;
}

const riskRank: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const minRisk = (a: Risk, b: Risk): Risk => (riskRank[a] <= riskRank[b] ? a : b);

/** Effective permissions of a verified token; undefined when its user is gone or disabled. */
export function accessFor(token: TokenInfo, users: UserStore): Access | undefined {
  if (!token.userId) {
    return { token, user: null, scope: token.scope, riskLimit: token.riskLimit, rooms: null, canRequestApproval: true, automations: true, label: token.name };
  }
  const user = users.get(token.userId);
  if (!user || user.disabled) return undefined;
  const guest = user.role === 'guest';
  const cap = guest ? 'low' : user.riskLimit;
  return {
    token,
    user,
    scope: minScope(token.scope, roleScope(user.role)),
    riskLimit: cap ? minRisk(token.riskLimit, cap) : token.riskLimit,
    rooms: user.allowedRooms ? new Set(user.allowedRooms) : null,
    canRequestApproval: !guest,
    automations: !guest,
    label: token.kind === 'session' ? user.username : token.name,
  };
}

export const canSeeDevice = (access: Pick<Access, 'rooms'>, device: Pick<Device, 'roomId'>): boolean =>
  access.rooms === null || (device.roomId !== null && device.roomId !== undefined && access.rooms.has(device.roomId));

/** What clients see about a user (never the password hash). */
export function publicUser(u: User): User {
  return { ...u };
}
