import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import type { AutomationEngine } from '@livynq/automation';
import { applyImport, listImports, openSource, planImport, revertImport } from '@livynq/importer-homeassistant';

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

const UPLOAD_ID = /^[0-9a-f-]{36}$/;
const UPLOAD_TTL_MS = 24 * 3600_000;

/** Backups uploaded from the browser wait here (owner-only) until planned / applied; kept a day. */
function uploadDir(home: Home): string {
  const dir = home.dataDir === ':memory:' ? join(tmpdir(), `livynq-imports-${process.pid}`) : join(home.dataDir, 'cache', 'imports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function sourceFrom(home: Home, body: unknown) {
  const upload = (body as { upload?: unknown } | undefined)?.upload;
  if (upload !== undefined) {
    if (typeof upload !== 'string' || !UPLOAD_ID.test(upload)) throw new LivynqError('INVALID_PARAMS', 'upload must be an id returned by POST /api/v1/imports/uploads');
    const file = join(uploadDir(home), `${upload}.tar`);
    try {
      statSync(file);
    } catch {
      throw new LivynqError('NOT_FOUND', 'Upload not found or expired; upload the backup again');
    }
    let name = 'backup';
    try {
      name = (JSON.parse(readFileSync(join(uploadDir(home), `${upload}.json`), 'utf8')) as { name: string }).name;
    } catch {
      // no sidecar: keep the generic name
    }
    // Import history shows where the config came from, not the cache path.
    return { ...openSource(file), description: `upload: ${name}` };
  }
  const path = (body as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new LivynqError('INVALID_PARAMS', 'path must be an absolute path on the Livynq host (HA config directory or backup .tar), or upload the backup');
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new LivynqError('NOT_FOUND', `Not found on the Livynq host: ${path}`);
  }
  if (stat.isFile() && stat.size > MAX_ARCHIVE_BYTES) {
    throw new LivynqError('INVALID_PARAMS', 'Archive larger than 200 MB', 'Use a partial backup without the database, or the extracted config directory');
  }
  return openSource(path);
}

export function registerImportRoutes(app: FastifyInstance, home: Home, guards: { admin: { preHandler: preHandlerAsyncHookHandler }; source(req: FastifyRequest): string }): void {
  const engine = () => home.extension<AutomationEngine>('automations');
  const { admin, source } = guards;

  // Raw upload of a backup archive from the browser (streamed to disk, size-limited).
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    scope.post('/api/v1/imports/uploads', { ...admin, bodyLimit: MAX_ARCHIVE_BYTES }, async (req, reply) => {
      const dir = uploadDir(home);
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (Date.now() - statSync(full).mtimeMs > UPLOAD_TTL_MS) rmSync(full, { force: true });
      }
      const body = req.body as Readable | undefined;
      if (!body || typeof body.pipe !== 'function') throw new LivynqError('INVALID_PARAMS', 'Send the archive as application/octet-stream');
      const id = randomUUID();
      const file = join(dir, `${id}.tar`);
      let size = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(file, { mode: 0o600 });
          body.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ARCHIVE_BYTES) body.destroy(new LivynqError('INVALID_PARAMS', 'Archive larger than 200 MB', 'Use a partial backup without the database'));
          });
          body.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          body.pipe(out);
        });
        if (!size) throw new LivynqError('INVALID_PARAMS', 'Empty upload');
        openSource(file); // fail early on files that are not HA backups
      } catch (err) {
        rmSync(file, { force: true });
        throw err;
      }
      const name = String((req.query as { name?: unknown }).name ?? '').replace(/[^\w .()-]/g, '_').slice(0, 100) || 'backup';
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ name }), { mode: 0o600 });
      return reply.status(201).send({ upload: id, size });
    });
  });

  app.post('/api/v1/imports/homeassistant/plan', admin, async (req) => {
    const { operations: _ops, ...report } = planImport(home, engine(), sourceFrom(home, req.body));
    return report;
  });
  app.post('/api/v1/imports/homeassistant/apply', admin, async (req) => {
    const body = (req.body ?? {}) as { enableAutomations?: boolean };
    const plan = planImport(home, engine(), sourceFrom(home, req.body));
    const record = applyImport(home, engine(), plan, source(req), { enableAutomations: body.enableAutomations === true });
    const { operations: _ops, ...report } = plan;
    return { import: record, report };
  });
  app.get('/api/v1/imports', admin, async () => listImports(home));
  app.post('/api/v1/imports/:id/revert', admin, async (req) => revertImport(home, engine(), (req.params as { id: string }).id));
}
