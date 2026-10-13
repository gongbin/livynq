import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import type { Placement } from '@livynq/model';

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** Floors, room outlines, device placement and 3D scene documents (design doc §16). */
export function registerSpaceRoutes(app: FastifyInstance, home: Home, guards: { read: { preHandler: preHandlerAsyncHookHandler }; admin: { preHandler: preHandlerAsyncHookHandler } }): void {
  const { read, admin } = guards;
  const assets = join(home.dataDir === ':memory:' ? join(tmpdir(), `livynq-memory-${process.pid}`) : home.dataDir, 'assets', 'levels');
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  // JPEG/PNG/WebP parsers are registered by the UI routes; floor plans may also be SVG.
  app.addContentTypeParser('image/svg+xml', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get('/api/v1/floorplan', read, async () => ({ ...home.spaces.floorPlan(), adjacency: home.spaces.adjacency() }));

  app.post('/api/v1/levels', admin, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; elevation?: number };
    return reply.status(201).send(home.spaces.createLevel({ name: body.name ?? '', elevation: body.elevation }));
  });
  app.patch('/api/v1/levels/:id', admin, async (req) => {
    const body = (req.body ?? {}) as { name?: string; elevation?: number; sortOrder?: number };
    return home.spaces.updateLevel(id(req), {
      ...(body.name !== undefined ? { name: String(body.name) } : {}),
      ...(body.elevation !== undefined ? { elevation: Number(body.elevation) } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: Number(body.sortOrder) } : {}),
    });
  });
  app.delete('/api/v1/levels/:id', admin, async (req, reply) => {
    for (const ext of Object.values(IMAGE_TYPES)) rmSync(join(assets, `${id(req)}.${ext}`), { force: true });
    home.spaces.deleteLevel(id(req));
    return reply.status(204).send();
  });

  // Floor plan image to trace over; ?widthMeters= sets its real-world width.
  app.put('/api/v1/levels/:id/background', admin, async (req) => {
    const level = home.spaces.getLevel(id(req));
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const ext = IMAGE_TYPES[type];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw new LivynqError('INVALID_PARAMS', 'Upload a JPEG, PNG, WebP or SVG image as the raw body');
    const widthMeters = Number((req.query as { widthMeters?: string }).widthMeters ?? level.background?.widthMeters ?? 12);
    if (!(widthMeters > 0 && widthMeters < 1000)) throw new LivynqError('INVALID_PARAMS', 'widthMeters must be between 0 and 1000');
    mkdirSync(assets, { recursive: true });
    for (const e of Object.values(IMAGE_TYPES)) rmSync(join(assets, `${level.id}.${e}`), { force: true });
    writeFileSync(join(assets, `${level.id}.${ext}`), req.body);
    const updatedAt = Date.now();
    return home.spaces.updateLevel(level.id, { background: { contentType: type, updatedAt, widthMeters, url: `/api/v1/levels/${level.id}/background?v=${updatedAt}` } });
  });
  // Rescale the tracing image without re-uploading it.
  app.patch('/api/v1/levels/:id/background', admin, async (req) => {
    const level = home.spaces.getLevel(id(req));
    if (!level.background) throw new LivynqError('NOT_FOUND', 'No background for this level');
    const widthMeters = Number((req.body as { widthMeters?: unknown } | undefined)?.widthMeters);
    if (!(widthMeters > 0 && widthMeters < 1000)) throw new LivynqError('INVALID_PARAMS', 'widthMeters must be between 0 and 1000');
    return home.spaces.updateLevel(level.id, { background: { ...level.background, widthMeters } });
  });
  app.delete('/api/v1/levels/:id/background', admin, async (req) => {
    for (const e of Object.values(IMAGE_TYPES)) rmSync(join(assets, `${id(req)}.${e}`), { force: true });
    return home.spaces.updateLevel(id(req), { background: null });
  });
  app.get('/api/v1/levels/:id/background', read, async (req, reply) => {
    const bg = home.spaces.getLevel(id(req)).background;
    const file = bg ? join(assets, `${id(req)}.${IMAGE_TYPES[bg.contentType]}`) : undefined;
    if (!bg || !file || !existsSync(file)) throw new LivynqError('NOT_FOUND', 'No background for this level');
    return reply.header('content-type', bg.contentType).header('cache-control', 'private, max-age=31536000, immutable').send(readFileSync(file));
  });

  app.get('/api/v1/levels/:id/scene', read, async (req) => home.spaces.getScene(id(req)) ?? { data: null, updatedAt: null });
  app.put('/api/v1/levels/:id/scene', { ...admin, bodyLimit: 6 * 1024 * 1024 }, async (req) => home.spaces.putScene(id(req), (req.body as { data?: unknown } | undefined)?.data ?? req.body));

  app.put('/api/v1/devices/:id/placement', admin, async (req) => {
    const body = req.body as Placement | null | undefined;
    const placement = body && typeof body === 'object' && 'levelId' in body ? body : null;
    if (placement && !['floor', 'wall', 'ceiling', 'furniture', undefined].includes(placement.mount)) throw new LivynqError('INVALID_PARAMS', 'mount must be floor, wall, ceiling or furniture');
    return home.spaces.place(id(req), placement ? { levelId: String(placement.levelId), x: Number(placement.x), y: Number(placement.y), ...(placement.z !== undefined ? { z: Number(placement.z) } : {}), ...(placement.rotation !== undefined ? { rotation: Number(placement.rotation) } : {}), ...(placement.mount ? { mount: placement.mount } : {}) } : null);
  });
}
