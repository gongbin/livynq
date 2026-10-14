import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { LivynqError, type Home } from '@livynq/core';
import type { AutomationEngine } from '@livynq/automation';

interface Guards {
  read: { preHandler: preHandlerAsyncHookHandler };
  control: { preHandler: preHandlerAsyncHookHandler };
  admin: { preHandler: preHandlerAsyncHookHandler };
  source(req: FastifyRequest): string;
}

/** Accepts a JSON automation object or `{ "yaml": "..." }`. */
function configFrom(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && typeof (body as { yaml?: unknown }).yaml === 'string') {
    let parsed: unknown;
    try {
      parsed = parseYaml((body as { yaml: string }).yaml);
    } catch (err) {
      throw new LivynqError('INVALID_PARAMS', `YAML: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LivynqError('INVALID_PARAMS', 'YAML must describe one automation (a mapping)');
    return parsed as Record<string, unknown>;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LivynqError('INVALID_PARAMS', 'Body must be an automation object or { yaml }');
  return body as Record<string, unknown>;
}

function isLocal(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  if (isIP(v4) === 4) return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4);
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

export function registerAutomationRoutes(app: FastifyInstance, home: Home, guards: Guards): void {
  const engine = () => {
    const e = home.extension<AutomationEngine>('automations');
    if (!e) throw new LivynqError('NOT_SUPPORTED', 'Automations are disabled');
    return e;
  };
  // Guests don't see or run automations (they reveal the whole home).
  const noGuests: preHandlerAsyncHookHandler = async (req) => {
    if (req.access && !req.access.automations) throw new LivynqError('FORBIDDEN', 'This account cannot use automations');
  };
  const read = { preHandler: [guards.read.preHandler, noGuests] };
  const control = { preHandler: [guards.control.preHandler, noGuests] };
  const { admin, source } = guards;
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/api/v1/automations', read, async () => engine().list());
  app.post('/api/v1/automations/validate', read, async (req) => {
    return engine().validate(configFrom(req.body));
  });
  app.post('/api/v1/automations', admin, async (req, reply) => {
    const q = req.query as { enabled?: string };
    const info = engine().save(configFrom(req.body), source(req), { onlyCreate: true, enabled: q.enabled === undefined ? undefined : q.enabled !== 'false' });
    return reply.status(201).send(info);
  });
  // Drafts from agents or scripts with "control" scope: always stored disabled and never overwrite.
  app.post('/api/v1/automations/proposals', control, async (req, reply) => {
    const info = engine().save(configFrom(req.body), source(req).replace(/^api:/, 'proposal:'), { onlyCreate: true, enabled: false });
    return reply.status(201).send(info);
  });
  app.get('/api/v1/automations/:id', read, async (req) => engine().get(id(req)));
  app.put('/api/v1/automations/:id', admin, async (req) => engine().save(configFrom(req.body), source(req), { id: id(req) }));
  app.delete('/api/v1/automations/:id', admin, async (req, reply) => {
    engine().remove(id(req));
    return reply.status(204).send();
  });
  app.post('/api/v1/automations/:id/enable', admin, async (req) => engine().setEnabled(id(req), true));
  app.post('/api/v1/automations/:id/disable', admin, async (req) => engine().setEnabled(id(req), false));
  app.post('/api/v1/automations/:id/trigger', control, async (req) => {
    const body = (req.body ?? {}) as { skip_conditions?: boolean };
    const runId = engine().trigger(id(req), { skipConditions: body.skip_conditions ?? true, source: source(req) });
    return { runId: runId ?? null, started: Boolean(runId) };
  });
  app.get('/api/v1/automations/:id/traces', read, async (req) => engine().traces(id(req)));
  app.get('/api/v1/automations/:id/traces/:runId', read, async (req) => engine().trace(id(req), (req.params as { runId: string }).runId));
  app.get('/api/v1/automations/:id/versions', read, async (req) => engine().versions(id(req)));

  // Webhooks are unauthenticated by design (the id is the secret), like Home Assistant.
  app.route({
    method: ['GET', 'POST', 'PUT', 'HEAD'],
    url: '/api/webhook/:webhookId',
    handler: async (req, reply) => {
      const automations = home.extension<AutomationEngine>('automations');
      automations?.handleWebhook((req.params as { webhookId: string }).webhookId, {
        method: req.method,
        local: isLocal(req.ip),
        json: req.body,
        query: req.query as Record<string, string>,
      });
      // Always 200 so callers cannot probe which ids exist.
      return reply.status(200).send();
    },
  });
}
