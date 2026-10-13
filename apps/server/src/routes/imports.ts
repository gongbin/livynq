import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import type { AutomationEngine } from '@livynq/automation';
import { applyImport, listImports, openSource, planImport, revertImport } from '@livynq/importer-homeassistant';

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

function sourceFrom(body: unknown) {
  const path = (body as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new LivynqError('INVALID_PARAMS', 'path must be an absolute path on the Livynq host (HA config directory or backup .tar)');
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

  app.post('/api/v1/imports/homeassistant/plan', admin, async (req) => {
    const { operations: _ops, ...report } = planImport(home, engine(), sourceFrom(req.body));
    return report;
  });
  app.post('/api/v1/imports/homeassistant/apply', admin, async (req) => {
    const body = (req.body ?? {}) as { enableAutomations?: boolean };
    const plan = planImport(home, engine(), sourceFrom(req.body));
    const record = applyImport(home, engine(), plan, source(req), { enableAutomations: body.enableAutomations === true });
    const { operations: _ops, ...report } = plan;
    return { import: record, report };
  });
  app.get('/api/v1/imports', admin, async () => listImports(home));
  app.post('/api/v1/imports/:id/revert', admin, async (req) => revertImport(home, engine(), (req.params as { id: string }).id));
}
