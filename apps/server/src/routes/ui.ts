import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import type { WallSettings } from '@livynq/model';

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const defaultWallSettings = (): WallSettings => ({ background: null, cardOpacity: 0.72, backgroundBlur: 0, backgroundDim: 0.25 });

export function wallSettings(home: Home): WallSettings {
  return { ...defaultWallSettings(), ...home.settings.get<Partial<WallSettings>>('ui.wall', {}) };
}

/** Hub-wide UI preferences, e.g. the wall panel look shared by every tablet. */
export function registerUiRoutes(app: FastifyInstance, home: Home, guards: { read: { preHandler: preHandlerAsyncHookHandler }; admin: { preHandler: preHandlerAsyncHookHandler } }): void {
  const assets = join(home.dataDir === ':memory:' ? join(tmpdir(), `livynq-memory-${process.pid}`) : home.dataDir, 'assets');

  app.addContentTypeParser(Object.keys(IMAGE_TYPES), { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  app.get('/api/v1/ui/settings', guards.read, async () => ({ wall: wallSettings(home) }));

  app.patch('/api/v1/ui/settings', guards.admin, async (req) => {
    const body = (req.body ?? {}) as { wall?: Partial<WallSettings> };
    const patch = body.wall ?? {};
    const range = (key: keyof WallSettings, min: number, max: number) => {
      const v = patch[key];
      if (v === undefined) return;
      if (typeof v !== 'number' || v < min || v > max) throw new LivynqError('INVALID_PARAMS', `wall.${key} must be a number ${min}..${max}`);
    };
    range('cardOpacity', 0.2, 1);
    range('backgroundBlur', 0, 40);
    range('backgroundDim', 0, 0.9);
    const { background: _ignored, ...rest } = patch;
    return { wall: home.settings.set('ui.wall', { ...wallSettings(home), ...rest }) };
  });

  app.put('/api/v1/ui/wall-background', guards.admin, async (req) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const ext = IMAGE_TYPES[type];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw new LivynqError('INVALID_PARAMS', 'Upload a JPEG, PNG or WebP image (raw body, ≤ 10 MB)');
    mkdirSync(assets, { recursive: true });
    for (const e of Object.values(IMAGE_TYPES)) rmSync(join(assets, `wall-background.${e}`), { force: true });
    writeFileSync(join(assets, `wall-background.${ext}`), req.body);
    const updatedAt = Date.now();
    return { wall: home.settings.set('ui.wall', { ...wallSettings(home), background: { contentType: type, updatedAt, url: `/api/v1/ui/wall-background?v=${updatedAt}` } }) };
  });

  app.delete('/api/v1/ui/wall-background', guards.admin, async () => {
    for (const e of Object.values(IMAGE_TYPES)) rmSync(join(assets, `wall-background.${e}`), { force: true });
    return { wall: home.settings.set('ui.wall', { ...wallSettings(home), background: null }) };
  });

  // Readable with ?token= so it can be used directly in CSS / <img>.
  app.get('/api/v1/ui/wall-background', guards.read, async (_req, reply) => {
    const bg = wallSettings(home).background;
    const file = bg ? join(assets, `wall-background.${IMAGE_TYPES[bg.contentType]}`) : undefined;
    if (!bg || !file || !existsSync(file)) throw new LivynqError('NOT_FOUND', 'No wall background set');
    return reply.header('content-type', bg.contentType).header('cache-control', 'private, max-age=31536000, immutable').send(readFileSync(file));
  });
}
