import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import type { AutomationEngine } from '@livynq/automation';
import { LLM_PRESETS, createProvider, createToolbox, generateAutomation, homeContext, restrictHomeApi, runAssistant, type ChatMessage, type HomeApi, type LlmSettings } from '@livynq/agent';

/**
 * Built-in assistant: model settings (admin; the API key stays in secrets/assistant.json and is
 * never returned), a streaming chat over the agent tools with the caller's own scope and risk
 * limit, and natural-language → automation drafts.
 */

interface Stored extends LlmSettings {
  preset?: string;
}

export interface AssistantSettingsDTO {
  configured: boolean;
  preset: string | null;
  provider: LlmSettings['provider'] | null;
  model: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  presets: typeof LLM_PRESETS;
}

export function registerAssistantRoutes(
  app: FastifyInstance,
  home: Home,
  api: HomeApi,
  version: string,
  guards: { read: { preHandler: preHandlerAsyncHookHandler }; control: { preHandler: preHandlerAsyncHookHandler }; admin: { preHandler: preHandlerAsyncHookHandler } },
): void {
  const file = home.dataDir === ':memory:' ? undefined : join(home.dataDir, 'secrets', 'assistant.json');
  let memory: Stored | undefined;
  const load = (): Stored | undefined => {
    if (!file) return memory;
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Stored;
    } catch {
      return undefined;
    }
  };
  const save = (s: Stored) => {
    if (!file) return void (memory = s);
    mkdirSync(join(home.dataDir, 'secrets'), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  };
  const dto = (s = load()): AssistantSettingsDTO => ({
    configured: Boolean(s?.model && (s.apiKey || s.provider === 'openai')),
    preset: s?.preset ?? null,
    provider: s?.provider ?? null,
    model: s?.model ?? null,
    baseUrl: s?.baseUrl ?? null,
    hasKey: Boolean(s?.apiKey),
    presets: LLM_PRESETS,
  });
  const provider = () => {
    const s = load();
    if (!s?.model) throw new LivynqError('NOT_SUPPORTED', 'The assistant is not set up yet', 'An admin can choose a model in Settings → Assistant');
    return createProvider(s);
  };
  const engine = () => {
    const e = home.extension<AutomationEngine>('automations');
    if (!e) throw new LivynqError('NOT_SUPPORTED', 'Automations are disabled');
    return e;
  };
  const lang = (v: unknown) => (v === 'en' ? 'en' : 'zh');

  app.get('/api/v1/assistant/settings', guards.read, async () => dto());

  app.put('/api/v1/assistant/settings', guards.admin, async (req) => {
    const b = (req.body ?? {}) as Partial<Stored> & { apiKey?: string | null };
    const current = load();
    if (b.provider !== 'anthropic' && b.provider !== 'openai') throw new LivynqError('INVALID_PARAMS', 'provider must be "anthropic" or "openai" (any OpenAI-compatible API)');
    const model = typeof b.model === 'string' ? b.model.trim() : '';
    if (!model) throw new LivynqError('INVALID_PARAMS', 'model is required');
    let baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim().replace(/\/+$/, '') : '';
    if (baseUrl) {
      try {
        const u = new URL(baseUrl);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        throw new LivynqError('INVALID_PARAMS', 'baseUrl must be an http(s) URL');
      }
    }
    // Omitted key keeps the stored one (the UI never sees it); "" or null removes it.
    const apiKey = b.apiKey === undefined ? current?.apiKey : b.apiKey ? String(b.apiKey).trim() : undefined;
    const next: Stored = { provider: b.provider, model, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}), ...(typeof b.preset === 'string' ? { preset: b.preset } : {}) };
    save(next);
    home.log.info({ provider: next.provider, model: next.model, baseUrl: next.baseUrl }, 'assistant settings changed');
    return dto(next);
  });

  /** Sends one short prompt with the given (or stored) settings. */
  app.post('/api/v1/assistant/test', guards.admin, async (req) => {
    const b = (req.body ?? {}) as Partial<Stored>;
    const s = load();
    const settings: LlmSettings = b.provider && b.model ? { provider: b.provider, model: b.model, ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}), ...((b.apiKey ?? s?.apiKey) ? { apiKey: b.apiKey ?? s?.apiKey } : {}) } : (s ?? { provider: 'openai', model: '' });
    const started = Date.now();
    try {
      let text = '';
      for await (const e of createProvider(settings).stream({ system: 'Reply with one short sentence.', messages: [{ role: 'user', content: 'Say hello to the Livynq smart home hub.' }], maxTokens: 60, signal: AbortSignal.timeout(30_000) })) {
        if (e.type === 'text') text += e.text;
      }
      return { ok: true, reply: text.trim().slice(0, 200), ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: (err as Error).message, ms: Date.now() - started };
    }
  });

  /** Server-sent events: one assistant turn. Body: { message, history?, lang? } */
  app.post('/api/v1/assistant/chat', guards.read, async (req, reply) => {
    const b = (req.body ?? {}) as { message?: unknown; history?: unknown; lang?: unknown };
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) throw new LivynqError('INVALID_PARAMS', 'message is required');
    if (message.length > 4000) throw new LivynqError('INVALID_PARAMS', 'message is too long');
    const history = Array.isArray(b.history) ? (b.history as ChatMessage[]).slice(-40) : [];
    const p = provider();
    const auth = req.auth!;
    const toolbox = createToolbox({ api: restrictHomeApi(api, req.access!), scope: auth.scope, riskLimit: auth.riskLimit, clientName: `assistant/${auth.name}`, version });
    const abort = new AbortController();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.on('close', () => abort.abort());
    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    try {
      for await (const e of runAssistant({ provider: p, toolbox, validateAutomation: (c) => engine().validate(c), lang: lang(b.lang), signal: abort.signal }, history, message)) send(e);
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  });

  /** "Turn on the hall light at sunset" → a validated automation config (not saved). */
  app.post('/api/v1/assistant/automation', guards.control, async (req) => {
    const b = (req.body ?? {}) as { description?: unknown; current?: unknown; lang?: unknown };
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    if (!description) throw new LivynqError('INVALID_PARAMS', 'description is required');
    if (!req.access!.automations) throw new LivynqError('FORBIDDEN', 'This account cannot use automations');
    const mine = restrictHomeApi(api, req.access!);
    const [rooms, devices] = await Promise.all([mine.rooms(), mine.devices()]);
    const current = b.current && typeof b.current === 'object' && !Array.isArray(b.current) ? (b.current as Record<string, unknown>) : undefined;
    return generateAutomation({ provider: provider(), description, context: homeContext(rooms, devices), validate: (c) => engine().validate(c), ...(current ? { current } : {}), lang: lang(b.lang), signal: AbortSignal.timeout(120_000) });
  });
}
