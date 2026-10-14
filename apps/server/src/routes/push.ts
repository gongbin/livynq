import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import type { PushInfo } from '@livynq/model';
import type { PushService } from '../push.ts';

/**
 * Web Push: every signed-in browser can subscribe itself (any scope); approval requests only go to
 * admin tokens. `POST /notify` lets scripts send a message like an automation's notify.notify.
 */
export function registerPushRoutes(
  app: FastifyInstance,
  home: Home,
  push: PushService,
  guards: { read: { preHandler: preHandlerAsyncHookHandler }; control: { preHandler: preHandlerAsyncHookHandler } },
): void {
  const stop = push.start();
  app.addHook('onClose', async () => stop());

  /** The caller's devices: subscriptions of any of their sessions / tokens (or of this token). */
  const tokensOf = (req: FastifyRequest): Set<string> => {
    const u = req.access?.user;
    return new Set(u ? home.tokens.list({ userId: u.id }).map((t) => t.id) : [req.auth!.id]);
  };
  const mine = (req: FastifyRequest) => {
    const ids = tokensOf(req);
    return push.list().filter((s) => ids.has(s.tokenId));
  };

  app.get('/api/v1/push', guards.read, async (req): Promise<PushInfo> => ({
    publicKey: push.vapid.publicKey,
    subscriptions: mine(req).map((s) => ({ endpoint: s.endpoint, name: s.name, createdAt: s.createdAt, ...(s.lastError ? { lastError: s.lastError } : {}) })),
  }));

  app.post('/api/v1/push/subscriptions', guards.read, async (req, reply) => {
    const body = (req.body ?? {}) as { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; name?: unknown };
    const s = body.subscription;
    if (typeof s?.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') {
      throw new LivynqError('INVALID_PARAMS', 'subscription { endpoint, keys: { p256dh, auth } } is required (PushSubscription.toJSON())');
    }
    try {
      const record = push.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, req.auth!, typeof body.name === 'string' ? body.name : '');
      return reply.status(201).send({ endpoint: record.endpoint, name: record.name, createdAt: record.createdAt });
    } catch (err) {
      throw new LivynqError('INVALID_PARAMS', (err as Error).message);
    }
  });

  app.delete('/api/v1/push/subscriptions', guards.read, async (req) => {
    const endpoint = String(((req.body ?? {}) as { endpoint?: unknown }).endpoint ?? '');
    const sub = push.list().find((s) => s.endpoint === endpoint);
    if (!sub) throw new LivynqError('NOT_FOUND', 'Not subscribed');
    if (!tokensOf(req).has(sub.tokenId) && req.auth!.scope !== 'admin') throw new LivynqError('FORBIDDEN', 'This subscription belongs to another token');
    push.unsubscribe(endpoint);
    return { ok: true };
  });

  // Test message to the caller's own devices.
  app.post('/api/v1/push/test', guards.read, async (req) => {
    const endpoint = ((req.body ?? {}) as { endpoint?: string }).endpoint;
    const ids = tokensOf(req);
    const result = await push.send(
      { id: `test-${Date.now()}`, title: 'Livynq', message: 'Notifications are working.', kind: 'message', source: `api:${req.auth!.name}`, ts: Date.now(), tag: 'livynq-test' },
      (s) => ids.has(s.tokenId) && (!endpoint || s.endpoint === endpoint),
    );
    if (!result.sent && !result.failed) throw new LivynqError('NOT_FOUND', 'No push subscription for this token');
    return result;
  });

  app.post('/api/v1/notify', guards.control, async (req) => {
    const body = (req.body ?? {}) as { message?: unknown; title?: unknown; url?: unknown; tag?: unknown };
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    if (!str(body.message)) throw new LivynqError('INVALID_PARAMS', 'message is required');
    return home.notify({ message: String(body.message), title: str(body.title), url: str(body.url), tag: str(body.tag) }, `api:${req.auth!.name}`);
  });
}
