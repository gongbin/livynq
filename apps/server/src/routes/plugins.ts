import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Adapter, type Home } from '@livynq/core';
import type { PluginRuntimeInfo } from '@livynq/plugin-host';
import type { PackageSource } from '../plugins/installer.ts';
import { publicResolution, type PluginManager } from '../plugins/manager.ts';

const MAX_UPLOAD = 100 * 1024 * 1024;
const UPLOAD_TTL = 15 * 60_000;

/**
 * Settings → Plugins (admin only): list with versions and updates, install from npm or a .tgz
 * (with a dry-run preview first), upgrade, enable / disable, configure, restart, uninstall.
 * Everything applies to the running hub.
 */
export function registerPluginRoutes(app: FastifyInstance, home: Home, manager: PluginManager, guards: { admin: { preHandler: preHandlerAsyncHookHandler } }): void {
  const admin = guards.admin;
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  // Without ?all: running adapters (the shape doctor / the wizard read), with version and source added.
  app.get('/api/v1/plugins', admin, async (req) => {
    const q = req.query as { all?: string; updates?: string; force?: string };
    if (q.all) return manager.list({ checkUpdates: Boolean(q.updates), force: Boolean(q.force) });
    const rows = new Map((await manager.list()).map((r) => [r.id, r]));
    return home.adapters().map((adapterId) => {
      const adapter = home.adapter<Adapter & { info?: () => PluginRuntimeInfo }>(adapterId);
      const row = rows.get(adapterId);
      return {
        ...(adapter?.info?.() ?? { id: adapterId, isolation: 'in-process', status: 'running', module: adapterId, builtin: true }),
        ...(row ? { version: row.version, source: row.source, package: row.module ?? row.path } : {}),
        actions: home.actions(adapterId),
      };
    });
  });

  app.post('/api/v1/plugins/:id/restart', admin, async (req) => manager.restart(id(req)));
  app.post('/api/v1/plugins/:id/enable', admin, async (req) => {
    const config = ((req.body ?? {}) as { config?: Record<string, unknown> }).config;
    return manager.enable(id(req), config);
  });
  app.post('/api/v1/plugins/:id/disable', admin, async (req) => manager.disable(id(req)));
  app.put('/api/v1/plugins/:id/config', admin, async (req) => manager.configure(id(req), ((req.body ?? {}) as { config?: Record<string, unknown> }).config as Record<string, unknown>));
  app.post('/api/v1/plugins/:id/upgrade', admin, async (req) => manager.upgrade(id(req)));

  // Uploaded .tgz files wait here between the preview and the install.
  const uploads = new Map<string, { data: Buffer; filename?: string; at: number }>();
  const keep = (data: Buffer, filename?: string) => {
    const now = Date.now();
    for (const [k, u] of uploads) if (now - u.at > UPLOAD_TTL) uploads.delete(k);
    while (uploads.size >= 3) uploads.delete(uploads.keys().next().value!);
    const key = randomBytes(12).toString('hex');
    uploads.set(key, { data, ...(filename ? { filename } : {}), at: now });
    return key;
  };

  void app.register(async (scope) => {
    scope.addContentTypeParser(['application/octet-stream', 'application/gzip', 'application/x-gzip', 'application/x-tar'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

    const sourceOf = (req: FastifyRequest): PackageSource & { uploadId?: string } => {
      const filename = (req.query as { filename?: string }).filename;
      if (Buffer.isBuffer(req.body)) return { tarball: req.body, ...(filename ? { filename } : {}) };
      const body = (req.body ?? {}) as { spec?: unknown; uploadId?: unknown };
      if (typeof body.uploadId === 'string') {
        const u = uploads.get(body.uploadId);
        if (!u) throw new LivynqError('NOT_FOUND', 'The uploaded file expired; upload it again');
        return { tarball: u.data, ...(u.filename ? { filename: u.filename } : {}), uploadId: body.uploadId };
      }
      if (typeof body.spec !== 'string' || !body.spec.trim()) throw new LivynqError('INVALID_PARAMS', 'spec (an npm package name, e.g. livynq-plugin-acme@1.2.0) or a .tgz upload is required');
      return { spec: body.spec };
    };

    scope.post('/api/v1/plugins/resolve', { ...admin, bodyLimit: MAX_UPLOAD }, async (req) => {
      const source = sourceOf(req);
      const preview = await manager.preview(source);
      const uploadId = 'tarball' in source ? (source.uploadId ?? keep(source.tarball, source.filename)) : undefined;
      const { _plan, ...rest } = preview;
      return { ...publicResolution(rest), ...(uploadId ? { uploadId } : {}) };
    });

    scope.post('/api/v1/plugins/install', { ...admin, bodyLimit: MAX_UPLOAD }, async (req, reply) => {
      const source = sourceOf(req);
      const q = req.query as { enable?: string; isolation?: string };
      const body = (Buffer.isBuffer(req.body) ? {} : (req.body ?? {})) as { enable?: boolean; config?: Record<string, unknown>; isolation?: string };
      const isolation = body.isolation ?? q.isolation;
      if (isolation !== undefined && isolation !== 'process' && isolation !== 'in-process') throw new LivynqError('INVALID_PARAMS', 'isolation must be "process" or "in-process"');
      const row = await manager.install(source, {
        enable: body.enable ?? q.enable !== 'false',
        ...(body.config ? { config: body.config } : {}),
        ...(isolation ? { isolation } : {}),
      });
      if ('uploadId' in source && source.uploadId) uploads.delete(source.uploadId);
      return reply.status(201).send(row);
    });
  });
}
