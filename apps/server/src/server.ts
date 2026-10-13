import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Logger as PinoLogger } from 'pino';
import { createBackup, Home, LivynqError, scopeAllows, toDeviceDTO, type Adapter, type Confirmation, type TokenInfo, type TokenScope } from '@livynq/core';
import type { Availability, CommandBody, Device, ExposurePolicy, Risk, HomeKitBridgeInfo, Room, StateChange, SystemInfo, WsClientMessage, WsServerMessage } from '@livynq/model';
import { createLocalHomeApi, handleMcpHttpRequest } from '@livynq/agent';
import { VERSION } from './version.ts';
import { registerAutomationRoutes } from './routes/automations.ts';
import { registerImportRoutes } from './routes/imports.ts';
import { registerUiRoutes, wallSettings } from './routes/ui.ts';
import type { PluginRuntimeInfo } from '@livynq/plugin-host';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: TokenInfo;
  }
}

/** Implemented by the HomeKit exporter; kept structural so the server does not depend on HAP types. */
export interface HomeKitInfoProvider {
  bridges(): HomeKitBridgeInfo[];
}

export interface ServerOptions {
  logger: PinoLogger;
  webRoot?: string;
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
  const authenticate = (req: FastifyRequest): TokenInfo => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    // Browsers cannot set headers on WebSocket connections or CSS images, so those may pass ?token=.
    const query = req.url.startsWith('/api/v1/ws') || req.url.startsWith('/api/v1/ui/wall-background') ? (req.query as Record<string, string | undefined>).token : undefined;
    const info = home.tokens.verify(bearer ?? query);
    if (!info) throw new LivynqError('UNAUTHORIZED', 'Missing or invalid access token', 'Pass "Authorization: Bearer lvq_..."');
    return info;
  };
  const requireScope = (scope: TokenScope) => async (req: FastifyRequest) => {
    req.auth = authenticate(req);
    if (!scopeAllows(req.auth.scope, scope)) throw new LivynqError('FORBIDDEN', `This token has scope "${req.auth.scope}", "${scope}" is required`);
  };
  const read = { preHandler: requireScope('read') };
  const control = { preHandler: requireScope('control') };
  const admin = { preHandler: requireScope('admin') };
  const source = (req: FastifyRequest) => `api:${req.auth?.name ?? 'unknown'}`;

  // ------------------------------------------------------------------ system
  app.get('/api/v1/system/info', read, async (): Promise<SystemInfo> => api.info());
  app.get('/api/v1/auth/me', read, async (req) => ({ token: req.auth }));
  app.get('/api/v1/health', async () => ({ ok: true }));

  // ------------------------------------------------------------------ devices
  app.get('/api/v1/devices', read, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return home.findDevices({ text: q.q, room: q.room, domain: q.domain, capability: q.capability }).map((d) => toDeviceDTO(home, d));
  });
  app.get('/api/v1/devices/:id', read, async (req) => {
    const { id } = req.params as { id: string };
    return toDeviceDTO(home, home.resolveTarget(id).device);
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
    const result = await home.confirmations.guard(
      { deviceId: id, endpointId: Number(ep), capability: body.capability, command: body.command, params: body.params },
      { source: source(req), riskLimit: req.auth!.riskLimit },
    );
    if (result.status === 'pending') return reply.status(202).send({ ok: false, pending: true, confirmation: result.confirmation });
    return { ok: true };
  });
  app.get('/api/v1/devices/:id/history', read, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    if (!q.capability || !q.attribute) throw new LivynqError('INVALID_PARAMS', 'capability and attribute are required');
    const target = home.resolveTarget(q.endpoint ? `${id}#${q.endpoint}` : id, q.capability);
    const to = q.to ? Number(q.to) : Date.now();
    const from = q.from ? Number(q.from) : to - 24 * 3600 * 1000;
    return home.registry.history(target.device.id, target.endpointId, q.capability, q.attribute, from, to);
  });
  app.get('/api/v1/entities', read, async () => home.registry.listEntities());
  app.patch('/api/v1/entities/:entityId', admin, async (req) => {
    const { entityId } = req.params as { entityId: string };
    const body = (req.body ?? {}) as { entityId?: string };
    if (!body.entityId) throw new LivynqError('INVALID_PARAMS', 'entityId is required');
    return home.registry.renameEntity(entityId, body.entityId);
  });

  // ------------------------------------------------------------------ rooms
  app.get('/api/v1/rooms', read, async () => home.registry.listRooms());
  app.post('/api/v1/rooms', admin, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; aliases?: string[] };
    return reply.status(201).send(home.registry.createRoom({ name: body.name ?? '', aliases: body.aliases }));
  });
  app.patch('/api/v1/rooms/:id', admin, async (req) => {
    const body = (req.body ?? {}) as { name?: string; aliases?: string[]; sortOrder?: number };
    return home.registry.updateRoom((req.params as { id: string }).id, body);
  });
  app.delete('/api/v1/rooms/:id', admin, async (req, reply) => {
    home.registry.deleteRoom((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ ecosystems & audit
  app.get('/api/v1/homekit', read, async () => {
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
  app.get('/api/v1/plugins', admin, async () =>
    home.adapters().map((id) => {
      const adapter = home.adapter<Adapter & { info?: () => PluginRuntimeInfo }>(id);
      return adapter?.info?.() ?? { id, isolation: 'in-process', status: 'running', module: id, builtin: true };
    }),
  );
  app.post('/api/v1/plugins/:id/restart', admin, async (req) => {
    const adapter = home.adapter<Adapter & { restart?: () => Promise<void>; info: () => PluginRuntimeInfo }>((req.params as { id: string }).id);
    if (!adapter?.restart) throw new LivynqError('NOT_SUPPORTED', 'Only process-isolated plugins can be restarted at runtime');
    await adapter.restart();
    return adapter.info();
  });
  app.get('/api/v1/commands/recent', read, async (req) => {
    const limit = Math.min(500, Number((req.query as Record<string, string>).limit ?? 50));
    return home.recentCommands(limit);
  });

  // ------------------------------------------------------------------ tokens
  app.get('/api/v1/tokens', admin, async () => home.tokens.list());
  app.post('/api/v1/tokens', admin, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; scope?: TokenScope; riskLimit?: Risk };
    return reply.status(201).send(home.tokens.create(body.name ?? 'token', body.scope ?? 'read', body.riskLimit));
  });

  // ------------------------------------------------------------------ confirmations (human in the loop)
  app.get('/api/v1/confirmations', read, async (req) => {
    const status = (req.query as { status?: string }).status;
    return home.confirmations.list(status as never);
  });
  app.get('/api/v1/confirmations/:id', read, async (req) => home.confirmations.get((req.params as { id: string }).id));
  app.post('/api/v1/confirmations/:id/approve', admin, async (req) => home.confirmations.approve((req.params as { id: string }).id, `web:${req.auth!.name}`));
  app.post('/api/v1/confirmations/:id/deny', admin, async (req) => home.confirmations.deny((req.params as { id: string }).id, `web:${req.auth!.name}`));
  app.delete('/api/v1/tokens/:id', admin, async (req, reply) => {
    home.tokens.revoke((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  registerAutomationRoutes(app, home, { read, control, admin, source });
  registerImportRoutes(app, home, { admin, source });
  registerUiRoutes(app, home, { read, admin });

  // ------------------------------------------------------------------ MCP (Streamable HTTP)
  app.all('/mcp', read, async (req, reply) => {
    reply.hijack();
    await handleMcpHttpRequest(req.raw, reply.raw, req.body, { api, scope: req.auth!.scope, riskLimit: req.auth!.riskLimit, clientName: req.auth!.name, version: VERSION });
  });

  // ------------------------------------------------------------------ WebSocket
  await app.register(fastifyWebsocket);
  app.get('/api/v1/ws', { websocket: true, preHandler: requireScope('read') }, (socket, req) => {
    const auth = req.auth!;
    const send = (msg: WsServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    send({ type: 'snapshot', devices: home.registry.listDevices().map((d) => toDeviceDTO(home, d)), rooms: home.registry.listRooms() });
    const off = home.bus.onAny((event, payload) => {
      switch (event) {
        case 'state': {
          const c = payload as StateChange;
          return send({ type: 'state', deviceId: c.deviceId, endpointId: c.endpointId, capability: c.capability, attribute: c.attribute, value: c.value, source: c.source, ts: c.ts });
        }
        case 'device.added':
        case 'device.updated':
          return send({ type: 'device', device: toDeviceDTO(home, payload as Device) });
        case 'device.removed':
          return send({ type: 'device.removed', id: (payload as { id: string }).id });
        case 'availability': {
          const a = payload as { deviceId: string; availability: Availability };
          return send({ type: 'availability', deviceId: a.deviceId, availability: a.availability });
        }
        case 'rooms.changed':
          return send({ type: 'rooms', rooms: payload as Room[] });
        case 'confirmation':
          return send({ type: 'confirmation', confirmation: payload as Confirmation });
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
        const result = await home.confirmations.guard(
          { deviceId: msg.deviceId, endpointId: msg.endpointId, capability: msg.capability, command: msg.command, params: msg.params },
          { source: `web:${auth.name}`, riskLimit: auth.riskLimit },
        );
        if (result.status === 'pending') {
          send({ type: 'result', id: msg.id, ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: `Needs approval: ${result.confirmation.summary}`, hint: result.confirmation.id } });
        } else send({ type: 'result', id: msg.id, ok: true });
      } catch (err) {
        const e = err instanceof LivynqError ? err : new LivynqError('INTERNAL', String(err));
        send({ type: 'result', id: msg.id, ok: false, error: e.toJSON() });
      }
    });
    socket.on('close', off);
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
  const { homekit, agent, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new LivynqError('INVALID_PARAMS', `Unknown exposure keys: ${Object.keys(rest).join(', ')}`);
  if (homekit !== undefined && typeof homekit !== 'boolean') throw new LivynqError('INVALID_PARAMS', 'exposure.homekit must be boolean');
  if (agent !== undefined && !['visible', 'readOnly', 'hidden'].includes(agent as string)) {
    throw new LivynqError('INVALID_PARAMS', 'exposure.agent must be visible, readOnly or hidden');
  }
  return { ...(homekit === undefined ? {} : { homekit }), ...(agent === undefined ? {} : { agent: agent as ExposurePolicy['agent'] }) };
}

function optional(value: unknown, type: 'string'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new LivynqError('INVALID_PARAMS', `Expected ${type}`);
  return value as string;
}
