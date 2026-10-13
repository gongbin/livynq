import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Logger as PinoLogger } from 'pino';
import { Home, LivynqError, scopeAllows, toDeviceDTO, type TokenInfo, type TokenScope } from '@livynq/core';
import type { Availability, CommandBody, Device, ExposurePolicy, HomeKitBridgeInfo, Room, StateChange, SystemInfo, WsClientMessage, WsServerMessage } from '@livynq/model';
import { createLocalHomeApi, handleMcpHttpRequest } from '@livynq/agent';
import { VERSION } from './version.ts';

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

const defaultWebRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

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
    // Browsers cannot set headers on WebSocket connections, so the socket may pass ?token=.
    const query = req.url.startsWith('/api/v1/ws') ? (req.query as Record<string, string | undefined>).token : undefined;
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
  app.post('/api/v1/devices/:id/endpoints/:ep/commands', control, async (req) => {
    const { id, ep } = req.params as { id: string; ep: string };
    const body = (req.body ?? {}) as CommandBody;
    if (typeof body.capability !== 'string' || typeof body.command !== 'string') {
      throw new LivynqError('INVALID_PARAMS', 'Body must be { capability, command, params? }');
    }
    await home.command({ deviceId: id, endpointId: Number(ep), capability: body.capability, command: body.command, params: body.params }, source(req));
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
  app.get('/api/v1/commands/recent', read, async (req) => {
    const limit = Math.min(500, Number((req.query as Record<string, string>).limit ?? 50));
    return home.recentCommands(limit);
  });

  // ------------------------------------------------------------------ tokens
  app.get('/api/v1/tokens', admin, async () => home.tokens.list());
  app.post('/api/v1/tokens', admin, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; scope?: TokenScope };
    return reply.status(201).send(home.tokens.create(body.name ?? 'token', body.scope ?? 'read'));
  });
  app.delete('/api/v1/tokens/:id', admin, async (req, reply) => {
    home.tokens.revoke((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ MCP (Streamable HTTP)
  app.all('/mcp', read, async (req, reply) => {
    reply.hijack();
    await handleMcpHttpRequest(req.raw, reply.raw, req.body, { api, scope: req.auth!.scope, clientName: req.auth!.name, version: VERSION });
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
        await home.command(
          { deviceId: msg.deviceId, endpointId: msg.endpointId, capability: msg.capability, command: msg.command, params: msg.params },
          `web:${auth.name}`,
        );
        send({ type: 'result', id: msg.id, ok: true });
      } catch (err) {
        const e = err instanceof LivynqError ? err : new LivynqError('INTERNAL', String(err));
        send({ type: 'result', id: msg.id, ok: false, error: e.toJSON() });
      }
    });
    socket.on('close', off);
  });

  // ------------------------------------------------------------------ web UI
  const webRoot = options.webRoot ?? defaultWebRoot;
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
