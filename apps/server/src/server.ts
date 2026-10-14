import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Logger as PinoLogger } from 'pino';
import { accessFor, canSeeDevice, createBackup, Home, LivynqError, scopeAllows, toDeviceDTO, type Access, type Adapter, type Confirmation, type HomeNotification, type TokenInfo, type TokenScope } from '@livynq/core';
import type { Availability, CommandBody, Device, ExposurePolicy, Level, Risk, HomeKitBridgeInfo, Room, StateChange, SystemInfo, WsClientMessage, WsServerMessage } from '@livynq/model';
import { createLocalHomeApi, handleMcpHttpRequest, restrictHomeApi } from '@livynq/agent';
import type { StreamHub } from '@livynq/media';
import { VERSION } from './version.ts';
import { registerAutomationRoutes } from './routes/automations.ts';
import { registerImportRoutes } from './routes/imports.ts';
import { registerUiRoutes, wallSettings } from './routes/ui.ts';
import { OFFICIAL, registerOnboardingRoutes } from './routes/onboarding.ts';
import { registerPluginRoutes } from './routes/plugins.ts';
import { PluginInstaller, pluginsDir } from './plugins/installer.ts';
import { PluginManager } from './plugins/manager.ts';
import { registerSpaceRoutes } from './routes/spaces.ts';
import { registerPushRoutes } from './routes/push.ts';
import { registerAssistantRoutes } from './routes/assistant.ts';
import { registerUserRoutes } from './routes/users.ts';
import { createCameraHub, registerCameraRoutes } from './routes/cameras.ts';
import { PushService } from './push.ts';
import type { LivynqConfig } from './config.ts';
import type { PluginDefinition } from '@livynq/sdk';

declare module 'fastify' {
  interface FastifyRequest {
    /** The token with its effective scope / risk limit (capped by the user's role) and audit name. */
    auth?: TokenInfo;
    /** Who is calling and what they may see (rooms) */
    access?: Access;
  }
}

/** Implemented by the HomeKit exporter; kept structural so the server does not depend on HAP types. */
export interface HomeKitInfoProvider {
  bridges(): HomeKitBridgeInfo[];
}

export interface ServerOptions {
  logger: PinoLogger;
  webRoot?: string;
  /** Lets the "Add device" wizard enable plugins and persist them. */
  config?: LivynqConfig;
  bundledPlugins?: Record<string, PluginDefinition>;
  /** Plugin lifecycle (tests inject one with a fake registry). */
  plugins?: PluginManager;
  /** Camera stream fan-out (tests inject one with short timeouts). */
  cameras?: StreamHub;
  /** Web Push sender (tests inject one with a fake push service). */
  push?: PushService;
}

/**
 * Web UI location: next to the sources in development; in the single executable the UI is an
 * embedded asset set, extracted once per version into the data directory.
 */
function resolveWebRoot(dataDir: string): string {
  const sea = isSea();
  if (!sea) return join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const target = join(dataDir === ':memory:' ? tmpdir() : dataDir, 'cache', `web-${VERSION}`);
  if (!existsSync(join(target, 'index.html'))) {
    const manifest = JSON.parse(sea.getAsset('web-manifest.json', 'utf8') as string) as string[];
    for (const file of manifest) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      writeFileSync(join(target, file), Buffer.from(sea.getAsset(`web/${file}`) as ArrayBuffer));
    }
  }
  return target;
}

function isSea(): { getAsset(key: string, encoding?: string): string | ArrayBuffer } | undefined {
  try {
    const sea = process.getBuiltinModule('node:sea') as { isSea(): boolean; getAsset(key: string, encoding?: string): string | ArrayBuffer };
    return sea.isSea() ? sea : undefined;
  } catch {
    return undefined;
  }
}

export async function createServer(home: Home, options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: options.logger.child({ module: 'http' }) as FastifyBaseLogger, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 1_048_576 });
  const api = createLocalHomeApi(home, VERSION);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof LivynqError) return reply.status(err.status).send({ error: err.toJSON() });
    const e = err as { statusCode?: number; validation?: unknown; message?: string };
    if (e.validation || e.statusCode === 400) return reply.status(400).send({ error: { code: 'INVALID_PARAMS', message: e.message } });
    app.log.error({ err }, 'request failed');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  // ------------------------------------------------------------------ auth
  const authenticate = (req: FastifyRequest): Access => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    // Browsers cannot set headers on WebSocket connections or CSS images, so those may pass ?token=.
    const query = req.url.startsWith('/api/v1/ws') || req.url.startsWith('/api/v1/cameras/') || req.url.startsWith('/api/v1/ui/wall-background') || /^\/api\/v1\/levels\/[^/]+\/background/.test(req.url) ? (req.query as Record<string, string | undefined>).token : undefined;
    const info = home.tokens.verify(bearer ?? query);
    const access = info && accessFor(info, home.users);
    if (!access) throw new LivynqError('UNAUTHORIZED', 'Missing or invalid access token', 'Sign in again, or pass "Authorization: Bearer lvq_..."');
    return access;
  };
  const attach = (req: FastifyRequest, access: Access) => {
    req.access = access;
    // Routes read scope / risk limit / name from req.auth: give them the effective values.
    req.auth = { ...access.token, scope: access.scope, riskLimit: access.riskLimit, name: access.label };
  };
  const requireScope = (scope: TokenScope) => async (req: FastifyRequest) => {
    attach(req, authenticate(req));
    if (!scopeAllows(req.auth!.scope, scope)) throw new LivynqError('FORBIDDEN', `This account has "${req.auth!.scope}" access, "${scope}" is required`);
  };
  const read = { preHandler: requireScope('read') };
  const control = { preHandler: requireScope('control') };
  const admin = { preHandler: requireScope('admin') };
  // Signs in when a token is given, otherwise continues anonymously (first-run setup).
  const maybeAuth = {
    preHandler: async (req: FastifyRequest) => {
      try {
        attach(req, authenticate(req));
      } catch {
        // anonymous
      }
    },
  };
  /** Audit source: people via the web UI, scripts and agents via their token name. */
  const source = (req: FastifyRequest) => (req.access?.token.kind === 'session' ? `web:${req.access.label}` : `api:${req.auth?.name ?? 'unknown'}`);
  const sees = (req: FastifyRequest) => (d: Device) => canSeeDevice(req.access!, d);
  /** Hidden devices look exactly like missing ones. */
  const visibleDevice = (req: FastifyRequest, ref: string, capability?: string) => {
    const target = home.resolveTarget(ref, capability);
    if (!canSeeDevice(req.access!, target.device)) throw new LivynqError('NOT_FOUND', `Device not found: ${ref}`);
    return target;
  };
  const unrestricted = (req: FastifyRequest) => {
    if (req.access!.rooms !== null) throw new LivynqError('FORBIDDEN', 'This account only has access to some rooms');
  };

  // ------------------------------------------------------------------ system
  app.get('/api/v1/system/info', read, async (): Promise<SystemInfo> => api.info());
  app.get('/api/v1/health', async () => ({ ok: true }));

  // ------------------------------------------------------------------ devices
  app.get('/api/v1/devices', read, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return home.findDevices({ text: q.q, room: q.room, domain: q.domain, capability: q.capability }).filter(sees(req)).map((d) => toDeviceDTO(home, d));
  });
  app.get('/api/v1/devices/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    return toDeviceDTO(home, visibleDevice(req, id).device);
  });
  app.patch('/api/v1/devices/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const device = home.registry.updateDevice(id, {
      name: optional(body.name, 'string'),
      roomId: body.roomId === null ? null : optional(body.roomId, 'string'),
      aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : undefined,
      exposure: parseExposure(body.exposure),
    });
    return toDeviceDTO(home, device);
  });
  app.delete('/api/v1/devices/:id', admin, async (req, reply) => {
    home.registry.removeDevice((req.params as { id: string }).id);
    return reply.status(204).send();
  });
  app.post('/api/v1/devices/:id/endpoints/:ep/commands', control, async (req, reply) => {
    const { id, ep } = req.params as { id: string; ep: string };
    const body = (req.body ?? {}) as CommandBody;
    if (typeof body.capability !== 'string' || typeof body.command !== 'string') {
      throw new LivynqError('INVALID_PARAMS', 'Body must be { capability, command, params? }');
    }
    visibleDevice(req, id);
    const result = await home.confirmations.guard(
      { deviceId: id, endpointId: Number(ep), capability: body.capability, command: body.command, params: body.params },
      { source: source(req), riskLimit: req.auth!.riskLimit, canRequestApproval: req.access!.canRequestApproval },
    );
    if (result.status === 'pending') return reply.status(202).send({ ok: false, pending: true, confirmation: result.confirmation });
    return { ok: true };
  });
  app.get('/api/v1/devices/:id/history', read, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    if (!q.capability || !q.attribute) throw new LivynqError('INVALID_PARAMS', 'capability and attribute are required');
    const target = visibleDevice(req, q.endpoint ? `${id}#${q.endpoint}` : id, q.capability);
    const to = q.to ? Number(q.to) : Date.now();
    const from = q.from ? Number(q.from) : to - 24 * 3600 * 1000;
    return home.registry.history(target.device.id, target.endpointId, q.capability, q.attribute, from, to);
  });
  app.get('/api/v1/entities', read, async (req) => {
    const shown = new Set(home.registry.listDevices().filter(sees(req)).map((d) => d.id));
    return home.registry.listEntities().filter((e) => shown.has(e.deviceId));
  });
  app.patch('/api/v1/entities/:entityId', admin, async (req) => {
    const { entityId } = req.params as { entityId: string };
    const body = (req.body ?? {}) as { entityId?: string };
    if (!body.entityId) throw new LivynqError('INVALID_PARAMS', 'entityId is required');
    return home.registry.renameEntity(entityId, body.entityId);
  });

  // ------------------------------------------------------------------ rooms
  app.get('/api/v1/rooms', read, async (req) => {
    const rooms = req.access!.rooms;
    return home.registry.listRooms().filter((r) => rooms === null || rooms.has(r.id));
  });
  app.post('/api/v1/rooms', admin, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; aliases?: string[] };
    return reply.status(201).send(home.registry.createRoom({ name: body.name ?? '', aliases: body.aliases }));
  });
  app.patch('/api/v1/rooms/:id', admin, async (req) => {
    const body = (req.body ?? {}) as { name?: string; aliases?: string[]; sortOrder?: number; levelId?: string | null; polygon?: [number, number][] | null; color?: string | null };
    if (body.levelId) home.spaces.getLevel(body.levelId);
    const roomId = (req.params as { id: string }).id;
    const levelAfter = body.levelId !== undefined ? body.levelId : home.registry.listRooms().find((r) => r.id === roomId)?.levelId;
    const polygonAfter = body.polygon !== undefined ? body.polygon : home.registry.listRooms().find((r) => r.id === roomId)?.polygon;
    if (polygonAfter && !levelAfter) throw new LivynqError('INVALID_PARAMS', 'A room outline needs a levelId');
    return home.registry.updateRoom((req.params as { id: string }).id, body);
  });
  app.delete('/api/v1/rooms/:id', admin, async (req, reply) => {
    home.registry.deleteRoom((req.params as { id: string }).id);
    // A guest limited to that room now has fewer rooms, never "all rooms".
    home.users.pruneRooms(new Set(home.registry.listRooms().map((r) => r.id)));
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ ecosystems & audit
  // Pairing codes let a phone take over every exposed device: not for room-restricted accounts.
  app.get('/api/v1/homekit', read, async (req) => {
    unrestricted(req);
    const provider = home.exporter('homekit') as unknown as HomeKitInfoProvider | undefined;
    return { enabled: Boolean(provider), bridges: provider?.bridges() ?? [] };
  });
  app.post('/api/v1/system/backup', admin, async (req, reply) => {
    const body = (req.body ?? {}) as { password?: string };
    if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 8)) {
      throw new LivynqError('INVALID_PARAMS', 'password must be at least 8 characters');
    }
    const { data } = createBackup(home, { version: VERSION, password: body.password });
    const name = `livynq-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${body.password ? '.lvqbak' : '.tar.gz'}`;
    return reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${name}"`).send(data);
  });
  app.post('/api/v1/plugins/:id/actions/:name', admin, async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    return { result: (await home.invokeAction(id, name, (req.body ?? {}) as Record<string, unknown>, source(req))) ?? null };
  });
  app.get('/api/v1/matter', read, async (req) => {
    unrestricted(req);
    const matter = home.exporter('matter') as unknown as { info(): unknown } | undefined;
    return matter?.info() ?? { enabled: false };
  });
  app.get('/api/v1/commands/recent', read, async (req) => {
    const limit = Math.min(500, Number((req.query as Record<string, string>).limit ?? 50));
    if (req.access!.rooms === null) return home.recentCommands(limit);
    const shown = new Set(home.registry.listDevices().filter(sees(req)).map((d) => d.id));
    return home.recentCommands(500).filter((c) => shown.has(String(c.device_id))).slice(0, limit);
  });

  // ------------------------------------------------------------------ tokens
  // API tokens (agents, scripts): admins see all, everyone else their own. Sessions are not listed.
  const tokenRow = (t: TokenInfo) => {
    const owner = t.userId ? home.users.get(t.userId) : undefined;
    return { ...t, owner: owner ? { id: owner.id, username: owner.username, displayName: owner.displayName } : null };
  };
  app.get('/api/v1/tokens', control, async (req) => {
    const a = req.access!;
    return home.tokens.list({ kind: 'api' }).filter((t) => a.scope === 'admin' || (a.user && t.userId === a.user.id)).map(tokenRow);
  });
  app.post('/api/v1/tokens', control, async (req, reply) => {
    const a = req.access!;
    if (!a.canRequestApproval) throw new LivynqError('FORBIDDEN', 'Guest accounts cannot create access tokens');
    const body = (req.body ?? {}) as { name?: string; scope?: TokenScope; riskLimit?: Risk };
    const scope = body.scope ?? 'read';
    if (!scopeAllows(a.scope, scope)) throw new LivynqError('FORBIDDEN', `You can create tokens up to "${a.scope}"`);
    const created = home.tokens.create(body.name ?? 'token', scope, body.riskLimit, { userId: a.user?.id ?? null });
    return reply.status(201).send({ ...created, info: tokenRow(created.info) });
  });

  // ------------------------------------------------------------------ confirmations (human in the loop)
  const seesConfirmation = (req: FastifyRequest, c: { request: { deviceId: string } }) => {
    const d = home.registry.getDevice(c.request.deviceId);
    return !d || canSeeDevice(req.access!, d);
  };
  app.get('/api/v1/confirmations', read, async (req) => {
    const status = (req.query as { status?: string }).status;
    return home.confirmations.list(status as never).filter((c) => seesConfirmation(req, c));
  });
  app.get('/api/v1/confirmations/:id', read, async (req) => {
    const c = home.confirmations.get((req.params as { id: string }).id);
    if (!seesConfirmation(req, c)) throw new LivynqError('NOT_FOUND', 'Confirmation not found');
    return c;
  });
  // Only admins approve: members and guests can't let an agent unlock the door.
  app.post('/api/v1/confirmations/:id/approve', admin, async (req) => home.confirmations.approve((req.params as { id: string }).id, source(req).replace(/^api:/, 'web:')));
  app.post('/api/v1/confirmations/:id/deny', admin, async (req) => home.confirmations.deny((req.params as { id: string }).id, source(req).replace(/^api:/, 'web:')));
  app.delete('/api/v1/tokens/:id', control, async (req, reply) => {
    const t = home.tokens.get((req.params as { id: string }).id);
    const a = req.access!;
    if (!t || t.kind !== 'api' || (a.scope !== 'admin' && (!a.user || t.userId !== a.user.id))) throw new LivynqError('NOT_FOUND', 'Token not found');
    home.tokens.revoke(t.id);
    return reply.status(204).send();
  });

  registerUserRoutes(app, home, { read, admin, optional: maybeAuth });
  registerAutomationRoutes(app, home, { read, control, admin, source });
  registerImportRoutes(app, home, { admin, source });
  registerUiRoutes(app, home, { read, admin });
  registerSpaceRoutes(app, home, { read, admin });
  const plugins =
    options.plugins ??
    new PluginManager(home, {
      installer: new PluginInstaller({ dir: pluginsDir(home.dataDir), hubVersion: VERSION, registry: options.config?.npmRegistry }),
      official: OFFICIAL,
      hubVersion: VERSION,
      configFile: options.config?.configFile,
      initialEntries: options.config?.plugins,
      bundled: options.bundledPlugins,
      resolveBuiltin: (specifier) => fileURLToPath(import.meta.resolve(specifier)),
    });
  registerOnboardingRoutes(app, home, { read, admin }, { config: options.config, plugins });
  registerPluginRoutes(app, home, plugins, { admin });
  registerPushRoutes(app, home, options.push ?? new PushService(home), { read, control });
  registerAssistantRoutes(app, home, api, VERSION, { read, control, admin });

  // ------------------------------------------------------------------ MCP (Streamable HTTP)
  app.all('/mcp', read, async (req, reply) => {
    reply.hijack();
    await handleMcpHttpRequest(req.raw, reply.raw, req.body, { api: restrictHomeApi(api, req.access!), scope: req.auth!.scope, riskLimit: req.auth!.riskLimit, clientName: req.auth!.name, version: VERSION });
  });

  // ------------------------------------------------------------------ WebSocket
  await app.register(fastifyWebsocket);
  registerCameraRoutes(app, home, options.cameras ?? createCameraHub(home), { read });
  app.get('/api/v1/ws', { websocket: true, preHandler: requireScope('read') }, (socket, req) => {
    const auth = req.auth!;
    const access = req.access!;
    const send = (msg: WsServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    // Room-restricted accounts only ever hear about what they can see.
    const allowedRooms = access.rooms;
    const roomsFor = (rooms: Room[]) => (allowedRooms === null ? rooms : rooms.filter((r) => allowedRooms.has(r.id)));
    const levelsFor = (levels: Level[]) => {
      if (allowedRooms === null) return levels;
      const keep = new Set(roomsFor(home.registry.listRooms()).map((r) => r.levelId));
      return levels.filter((l) => keep.has(l.id));
    };
    const shown = new Set<string>();
    const visibleId = (deviceId: string) => {
      if (allowedRooms === null) return true;
      const d = home.registry.getDevice(deviceId);
      return Boolean(d && canSeeDevice(access, d));
    };
    const snapshot = home.registry.listDevices().filter((d) => canSeeDevice(access, d));
    for (const d of snapshot) shown.add(d.id);
    send({ type: 'snapshot', devices: snapshot.map((d) => toDeviceDTO(home, d)), rooms: roomsFor(home.registry.listRooms()), levels: levelsFor(home.spaces.listLevels()) });
    const off = home.bus.onAny((event, payload) => {
      switch (event) {
        case 'state': {
          const c = payload as StateChange;
          if (!visibleId(c.deviceId)) return;
          return send({ type: 'state', deviceId: c.deviceId, endpointId: c.endpointId, capability: c.capability, attribute: c.attribute, value: c.value, source: c.source, ts: c.ts });
        }
        case 'device.added':
        case 'device.updated': {
          const d = payload as Device;
          if (canSeeDevice(access, d)) {
            shown.add(d.id);
            return send({ type: 'device', device: toDeviceDTO(home, d) });
          }
          // Moved out of the allowed rooms: gone for this viewer.
          if (shown.delete(d.id)) send({ type: 'device.removed', id: d.id });
          return;
        }
        case 'device.removed': {
          const id = (payload as { id: string }).id;
          if (allowedRooms !== null && !shown.delete(id)) return;
          return send({ type: 'device.removed', id });
        }
        case 'availability': {
          const a = payload as { deviceId: string; availability: Availability };
          if (!visibleId(a.deviceId)) return;
          return send({ type: 'availability', deviceId: a.deviceId, availability: a.availability });
        }
        case 'rooms.changed':
          return send({ type: 'rooms', rooms: roomsFor(payload as Room[]) });
        case 'confirmation': {
          const c = payload as Confirmation;
          if (!visibleId(c.request.deviceId)) return;
          return send({ type: 'confirmation', confirmation: c });
        }
        case 'levels.changed':
          return send({ type: 'levels', levels: levelsFor(payload as Level[]) });
        case 'notification': {
          const n = payload as HomeNotification;
          if (n.kind === 'confirmation' && auth.scope !== 'admin') return;
          return send({ type: 'notification', notification: n });
        }
        case 'settings':
          if ((payload as { key: string }).key === 'ui.wall') send({ type: 'settings', wall: wallSettings(home) });
          return;
      }
    });
    socket.on('message', async (raw: Buffer) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.type !== 'command' || typeof msg.id !== 'number') return;
      try {
        if (!scopeAllows(auth.scope, 'control')) throw new LivynqError('FORBIDDEN', 'Token cannot control devices');
        if (!visibleId(msg.deviceId)) throw new LivynqError('NOT_FOUND', `Device not found: ${msg.deviceId}`);
        const result = await home.confirmations.guard(
          { deviceId: msg.deviceId, endpointId: msg.endpointId, capability: msg.capability, command: msg.command, params: msg.params },
          { source: `web:${auth.name}`, riskLimit: auth.riskLimit, canRequestApproval: access.canRequestApproval },
        );
        if (result.status === 'pending') {
          send({ type: 'result', id: msg.id, ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: `Needs approval: ${result.confirmation.summary}`, hint: result.confirmation.id } });
        } else send({ type: 'result', id: msg.id, ok: true });
      } catch (err) {
        const e = err instanceof LivynqError ? err : new LivynqError('INTERNAL', String(err));
        send({ type: 'result', id: msg.id, ok: false, error: e.toJSON() });
      }
    });
    // A revoked session or a disabled account closes the live connection too.
    const recheck = setInterval(() => {
      const t = home.tokens.get(access.token.id);
      if (!t || !accessFor(t, home.users)) socket.close(4001, 'signed out');
    }, 30_000);
    socket.on('close', () => {
      off();
      clearInterval(recheck);
    });
  });

  // ------------------------------------------------------------------ web UI
  const webRoot = options.webRoot ?? resolveWebRoot(home.dataDir);
  if (existsSync(join(webRoot, 'index.html'))) {
    // wildcard: serve files created after startup too (rebuilding the UI must not need a restart).
    await app.register(fastifyStatic, { root: webRoot, wildcard: true, index: false });
    app.get('/', (_req, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      const isRoute = !req.url.startsWith('/api/') && !req.url.startsWith('/mcp') && !req.url.startsWith('/assets/');
      if (req.method === 'GET' && isRoute) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<h1>Livynq</h1><p>Web UI is not built. Run <code>pnpm build:web</code>.</p>'),
    );
  }

  return app;
}

function parseExposure(value: unknown): Partial<ExposurePolicy> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new LivynqError('INVALID_PARAMS', 'exposure must be an object');
  const { homekit, agent, matter, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new LivynqError('INVALID_PARAMS', `Unknown exposure keys: ${Object.keys(rest).join(', ')}`);
  if (homekit !== undefined && typeof homekit !== 'boolean') throw new LivynqError('INVALID_PARAMS', 'exposure.homekit must be boolean');
  if (matter !== undefined && typeof matter !== 'boolean') throw new LivynqError('INVALID_PARAMS', 'exposure.matter must be boolean');
  if (agent !== undefined && !['visible', 'readOnly', 'hidden'].includes(agent as string)) {
    throw new LivynqError('INVALID_PARAMS', 'exposure.agent must be visible, readOnly or hidden');
  }
  return { ...(homekit === undefined ? {} : { homekit }), ...(matter === undefined ? {} : { matter }), ...(agent === undefined ? {} : { agent: agent as ExposurePolicy['agent'] }) };
}

function optional(value: unknown, type: 'string'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new LivynqError('INVALID_PARAMS', `Expected ${type}`);
  return value as string;
}
