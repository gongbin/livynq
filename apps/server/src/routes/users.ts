import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, ROLES, checkPassword, roleScope, type Access, type Home, type Role, type User } from '@livynq/core';
import type { Risk } from '@livynq/model';

/**
 * Accounts and sign-in.
 *
 * First run: while no account exists, the owner account can be created (POST /auth/setup) only
 * by a request that already holds an admin token (the link printed by `livynq login-url` on the
 * hub machine), or by a request from the hub machine itself (loopback). Nobody on the LAN can
 * claim an empty hub without access to the machine.
 */

type Guard = { preHandler: preHandlerAsyncHookHandler };

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/** Per IP + user name: 5 free failures, then exponential lock-out (30 s doubling, max 15 min). */
export class LoginLimiter {
  readonly #fails = new Map<string, { count: number; until: number; at: number }>();

  check(key: string, now = Date.now()): number {
    const f = this.#fails.get(key);
    return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()): void {
    // Old entries are forgotten after a day.
    for (const [k, v] of this.#fails) if (now - v.at > 86_400_000) this.#fails.delete(k);
    const f = this.#fails.get(key) ?? { count: 0, until: 0, at: now };
    f.count++;
    f.at = now;
    if (f.count >= 5) f.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (f.count - 5));
    this.#fails.set(key, f);
  }

  succeed(key: string): void {
    this.#fails.delete(key);
  }
}

export function registerUserRoutes(
  app: FastifyInstance,
  home: Home,
  guards: { read: Guard; admin: Guard; optional: Guard },
  options: { limiter?: LoginLimiter } = {},
): void {
  const limiter = options.limiter ?? new LoginLimiter();
  const access = (req: FastifyRequest): Access => req.access!;
  const actor = (req: FastifyRequest) => access(req).user;

  const session = (user: User, req: FastifyRequest) => {
    const agent = String(req.headers['user-agent'] ?? '').slice(0, 80);
    return home.tokens.create(`session:${user.username}${agent ? ` · ${agent}` : ''}`, roleScope(user.role), undefined, { userId: user.id, kind: 'session' });
  };
  const me = (a: Access) => ({
    token: { id: a.token.id, name: a.label, scope: a.scope, riskLimit: a.riskLimit, kind: a.token.kind, createdAt: a.token.createdAt, lastUsedAt: a.token.lastUsedAt },
    user: a.user,
    access: { rooms: a.rooms ? [...a.rooms] : null, automations: a.automations, canRequestApproval: a.canRequestApproval },
  });

  // ---------------------------------------------------------------- sign-in

  /** Unauthenticated: what the sign-in screen should offer. */
  app.get('/api/v1/auth/status', async (req) => {
    const users = home.users.count() > 0;
    return { users, setupHere: !users && isLoopback(req.ip) };
  });

  app.post('/api/v1/auth/setup', guards.optional, async (req, reply) => {
    if (home.users.count() > 0) throw new LivynqError('CONFLICT', 'The owner account already exists; sign in instead');
    const a = req.access;
    if (!(a && a.scope === 'admin') && !isLoopback(req.ip)) {
      throw new LivynqError('FORBIDDEN', 'Create the owner account from the hub machine, or open the link from "livynq login-url" first');
    }
    const b = (req.body ?? {}) as { username?: unknown; displayName?: unknown; password?: unknown };
    const user = await home.users.create({ username: String(b.username ?? ''), displayName: typeof b.displayName === 'string' ? b.displayName : undefined, password: String(b.password ?? ''), role: 'owner' });
    home.log.info({ username: user.username }, 'owner account created');
    home.users.markLogin(user.id);
    const { token } = session(user, req);
    return reply.status(201).send({ token, user });
  });

  app.post('/api/v1/auth/login', async (req) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(b.username ?? '').trim().toLowerCase();
    const key = `${req.ip}|${username}`;
    const wait = limiter.check(key);
    if (wait) throw new LivynqError('RATE_LIMITED', `Too many attempts; try again in ${wait} s`);
    const user = await home.users.authenticate(username, String(b.password ?? ''));
    if (!user) {
      limiter.fail(key);
      throw new LivynqError('UNAUTHORIZED', 'Wrong user name or password');
    }
    limiter.succeed(key);
    const { token } = session(user, req);
    home.log.info({ username: user.username, ip: req.ip }, 'signed in');
    return { token, user };
  });

  app.get('/api/v1/auth/me', guards.read, async (req) => me(access(req)));

  app.post('/api/v1/auth/logout', guards.read, async (req) => {
    const a = access(req);
    if (a.token.kind === 'session') home.tokens.revoke(a.token.id);
    return { ok: true };
  });

  app.post('/api/v1/auth/logout-all', guards.read, async (req) => {
    const u = actor(req);
    if (!u) throw new LivynqError('INVALID_PARAMS', 'This token does not belong to an account');
    return { signedOut: home.tokens.revokeForUser(u.id, 'session') };
  });

  app.post('/api/v1/auth/password', guards.read, async (req) => {
    const u = actor(req);
    if (!u) throw new LivynqError('INVALID_PARAMS', 'This token does not belong to an account');
    const b = (req.body ?? {}) as { current?: unknown; password?: unknown };
    if (!(await home.users.checkOwnPassword(u.id, String(b.current ?? '')))) throw new LivynqError('FORBIDDEN', 'The current password is wrong');
    await home.users.setPassword(u.id, checkPassword(b.password));
    // Other sessions sign out; this one stays.
    for (const t of home.tokens.list({ userId: u.id, kind: 'session' })) if (t.id !== access(req).token.id) home.tokens.revoke(t.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- users (admins)

  /** Admins manage members and guests; only the owner manages admins. */
  const mayManage = (by: User | null, target: User) => {
    if (!by) return true; // a token from before accounts existed (CLI): full admin
    if (by.role === 'owner') return true;
    return target.role === 'member' || target.role === 'guest';
  };
  const mayAssign = (by: User | null, role: Role) => role !== 'owner' && (!by || by.role === 'owner' || role === 'member' || role === 'guest');
  const roomsOf = (v: unknown): string[] | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (!Array.isArray(v)) throw new LivynqError('INVALID_PARAMS', 'allowedRooms must be a list of room ids or null');
    const known = new Set(home.registry.listRooms().map((r) => r.id));
    for (const r of v) if (!known.has(String(r))) throw new LivynqError('INVALID_PARAMS', `Unknown room ${String(r)}`);
    return v.map(String);
  };
  const riskOf = (v: unknown): Risk | null | undefined => {
    if (v === undefined || v === null) return v as null | undefined;
    if (v !== 'low' && v !== 'medium' && v !== 'high') throw new LivynqError('INVALID_PARAMS', 'riskLimit must be low, medium or high');
    return v;
  };

  app.get('/api/v1/users', guards.admin, async () => home.users.list().map((u) => ({ ...u, sessions: home.tokens.list({ userId: u.id, kind: 'session' }).length })));

  app.post('/api/v1/users', guards.admin, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const role = String(b.role ?? 'member') as Role;
    if (!ROLES.includes(role)) throw new LivynqError('INVALID_PARAMS', `role must be one of ${ROLES.join(', ')}`);
    if (!home.users.owner()) throw new LivynqError('INVALID_PARAMS', 'Create the owner account first (POST /api/v1/auth/setup)');
    if (!mayAssign(actor(req), role)) throw new LivynqError('FORBIDDEN', role === 'owner' ? 'Use "transfer ownership"' : 'Only the owner can add admins');
    const user = await home.users.create({
      username: String(b.username ?? ''),
      displayName: typeof b.displayName === 'string' ? b.displayName : undefined,
      password: String(b.password ?? ''),
      role,
      allowedRooms: roomsOf(b.allowedRooms) ?? null,
      riskLimit: riskOf(b.riskLimit) ?? null,
    });
    return reply.status(201).send(user);
  });

  app.patch('/api/v1/users/:id', guards.admin, async (req) => {
    const target = home.users.require((req.params as { id: string }).id);
    const by = actor(req);
    if (!mayManage(by, target)) throw new LivynqError('FORBIDDEN', 'Only the owner can change admins');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const role = b.role === undefined ? undefined : (String(b.role) as Role);
    if (role && role !== target.role && !mayAssign(by, role)) throw new LivynqError('FORBIDDEN', 'Only the owner can make someone an admin');
    if (by && by.id === target.id && b.disabled === true) throw new LivynqError('INVALID_PARAMS', 'You cannot disable your own account');
    const updated = home.users.update(target.id, {
      ...(typeof b.displayName === 'string' ? { displayName: b.displayName } : {}),
      ...(role ? { role } : {}),
      ...(b.allowedRooms !== undefined ? { allowedRooms: roomsOf(b.allowedRooms) ?? null } : {}),
      ...(b.riskLimit !== undefined ? { riskLimit: riskOf(b.riskLimit) ?? null } : {}),
      ...(typeof b.disabled === 'boolean' ? { disabled: b.disabled } : {}),
    });
    // A disabled account is signed out everywhere.
    if (updated.disabled) home.tokens.revokeForUser(updated.id, 'session');
    return updated;
  });

  app.post('/api/v1/users/:id/password', guards.admin, async (req) => {
    const target = home.users.require((req.params as { id: string }).id);
    if (!mayManage(actor(req), target)) throw new LivynqError('FORBIDDEN', 'Only the owner can change admins');
    await home.users.setPassword(target.id, checkPassword(((req.body ?? {}) as { password?: unknown }).password));
    home.tokens.revokeForUser(target.id, 'session');
    return { ok: true };
  });

  app.delete('/api/v1/users/:id', guards.admin, async (req, reply) => {
    const target = home.users.require((req.params as { id: string }).id);
    const by = actor(req);
    if (!mayManage(by, target)) throw new LivynqError('FORBIDDEN', 'Only the owner can remove admins');
    if (by?.id === target.id) throw new LivynqError('INVALID_PARAMS', 'You cannot delete your own account');
    home.users.remove(target.id);
    home.tokens.revokeForUser(target.id);
    return reply.status(204).send();
  });

  app.post('/api/v1/users/:id/transfer-ownership', guards.admin, async (req) => {
    const by = actor(req);
    if (!by || by.role !== 'owner') throw new LivynqError('FORBIDDEN', 'Only the owner can transfer ownership');
    const { to } = home.users.transferOwnership(by.id, (req.params as { id: string }).id);
    home.log.info({ from: by.username, to: to.username }, 'ownership transferred');
    return to;
  });
}
