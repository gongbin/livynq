import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { DemoAdapter, Home } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';
import { createServer as createHub } from '../src/server.ts';

/** An OpenAI-compatible model that answers from a script, per request. */
async function fakeModel(script: (body: Record<string, any>) => unknown[]) {
  const requests: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, any>;
      requests.push({ ...body, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const delta of script(body)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close() };
}

const toolCall = (name: string, args: unknown, id = 'c1') => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('assistant: settings keep the key secret, chat runs tools with the caller scope, NL automations', async () => {
  const model = await fakeModel((body) => {
    const last = body.messages.at(-1);
    if (body.tool_choice?.function?.name === 'submit_automation') {
      return [toolCall('submit_automation', { automation: { alias: '日落开灯', triggers: [{ trigger: 'sun', event: 'sunset' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.bedroom_lamp' } }] }, explanation: '日落时打开卧室台灯' })];
    }
    if (last.role === 'user' && /开/.test(last.content)) return [{ content: '好的。' }, toolCall('control_device', { target: 'light.bedroom_lamp', action: 'turn_on' })];
    if (last.role === 'tool') return [{ content: '卧室台灯已打开。' }];
    return [{ content: 'Hello!' }];
  });
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExtension(new AutomationEngine());
  const app = await createHub(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent' });
  await home.start();
  const admin = home.tokens.create('admin', 'admin').token;
  const reader = home.tokens.create('wall', 'read').token;
  const req = (method: string, url: string, token: string, payload?: unknown) => app.inject({ method: method as 'GET', url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  const events = (body: string) => body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as { type: string; [k: string]: unknown });
  try {
    assert.equal((await req('GET', '/api/v1/assistant/settings', reader)).json().configured, false);
    assert.equal((await req('POST', '/api/v1/assistant/chat', admin, { message: 'hi' })).json().error.code, 'NOT_SUPPORTED');
    assert.equal((await req('PUT', '/api/v1/assistant/settings', reader, { provider: 'openai', model: 'm' })).statusCode, 403);

    const put = await req('PUT', '/api/v1/assistant/settings', admin, { provider: 'openai', model: 'qwen-plus', baseUrl: model.base, apiKey: 'sk-secret', preset: 'qwen' });
    assert.equal(put.statusCode, 200);
    assert.deepEqual([put.json().configured, put.json().hasKey, put.json().model], [true, true, 'qwen-plus']);
    assert.ok(!JSON.stringify(put.json()).includes('sk-secret'), 'the key is never returned');
    // Saving without a key keeps the stored one.
    await req('PUT', '/api/v1/assistant/settings', admin, { provider: 'openai', model: 'qwen-max', baseUrl: model.base });
    assert.equal((await req('GET', '/api/v1/assistant/settings', reader)).json().hasKey, true);

    const t = (await req('POST', '/api/v1/assistant/test', admin, {})).json();
    assert.deepEqual([t.ok, t.reply], [true, 'Hello!']);
    assert.equal(model.requests.at(-1)!.auth, 'Bearer sk-secret');

    // Chat as admin: the model turns a lamp on through control_device.
    const chat = await req('POST', '/api/v1/assistant/chat', admin, { message: '开一下卧室台灯', lang: 'zh' });
    assert.equal(chat.headers['content-type'], 'text/event-stream; charset=utf-8');
    const ev = events(chat.body);
    assert.deepEqual(ev.filter((e) => e.type === 'toolResult').map((e) => [e.name, e.ok]), [['control_device', true]]);
    assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), '好的。卧室台灯已打开。');
    assert.equal(home.registry.getAttribute('demo:bedroom-lamp', 1, 'onOff', 'onOff'), true);
    assert.match(String(home.recentCommands(1)[0]!.source), /^agent:assistant\/admin/);
    const done = ev.at(-1)!;
    assert.equal(done.type, 'done');
    assert.equal((done.messages as unknown[]).length, 4, 'user, assistant+tool call, tool result, final answer');

    // A read-only token chats without control tools.
    await req('POST', '/api/v1/assistant/chat', reader, { message: 'hello' });
    assert.deepEqual(model.requests.at(-1)!.tools.map((x: { function: { name: string } }) => x.function.name).includes('control_device'), false);

    // Natural language → validated automation, not saved
    const gen = (await req('POST', '/api/v1/assistant/automation', admin, { description: '日落时打开卧室台灯' })).json();
    assert.deepEqual([gen.errors, gen.explanation, gen.attempts], [[], '日落时打开卧室台灯', 1]);
    assert.equal(gen.config.alias, '日落开灯');
    assert.match(model.requests.at(-1)!.messages[0].content, /light\.bedroom_lamp/, 'the prompt lists the home’s entities');
    assert.equal((await req('GET', '/api/v1/automations', admin)).json().length, 0);
    assert.equal((await req('POST', '/api/v1/assistant/automation', reader, { description: 'x' })).statusCode, 403);
  } finally {
    await app.close();
    await home.stop();
    model.close();
  }
});
