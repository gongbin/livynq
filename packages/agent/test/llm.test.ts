import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { anthropicMessages, anthropicProvider, generateAutomation, openaiProvider, runAssistant, type AssistantEvent, type ChatMessage, type LlmProvider, type StreamEvent, type Toolbox } from '../src/index.ts';

async function serve(handler: (body: Record<string, any>, req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => handler(JSON.parse(raw || '{}'), req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const collect = async (it: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

test('Anthropic: request shape, streamed text and tool calls', async () => {
  let seen: { body?: Record<string, any>; headers?: IncomingMessage['headers'] } = {};
  const s = await serve((body, req, res) => {
    seen = { body, headers: req.headers };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
    ev('message_start', { message: { usage: { input_tokens: 42 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '好的，' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '我看看。' } });
    ev('content_block_stop', { index: 0 });
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_devices', input: {} } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"room": "Kit' } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'chen"}' } });
    ev('content_block_stop', { index: 1 });
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } });
    ev('message_stop', {});
    res.end();
  });
  try {
    const p = anthropicProvider({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test', baseUrl: s.base });
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'home_overview', args: {} }, { id: 'b', name: 'list_devices', args: {} }] },
      { role: 'tool', toolCallId: 'a', name: 'home_overview', content: '{}' },
      { role: 'tool', toolCallId: 'b', name: 'list_devices', content: 'oops', isError: true },
    ];
    const events = await collect(p.stream({ system: 'sys', messages: history, tools: [{ name: 'list_devices', description: 'd', parameters: { type: 'object' } }] }));
    assert.deepEqual(events, [
      { type: 'text', text: '好的，' },
      { type: 'text', text: '我看看。' },
      { type: 'toolCall', call: { id: 'toolu_1', name: 'list_devices', args: { room: 'Kitchen' } } },
      { type: 'done', stopReason: 'tool_use', usage: { input: 42, output: 17 } },
    ]);
    assert.equal(seen.headers!['x-api-key'], 'sk-test');
    assert.equal(seen.headers!['anthropic-version'], '2023-06-01');
    assert.equal(seen.body!.system, 'sys');
    assert.deepEqual(seen.body!.tools, [{ name: 'list_devices', description: 'd', input_schema: { type: 'object' } }]);
    // Both tool results travel in one user message, after the assistant's tool_use blocks.
    assert.deepEqual(seen.body!.messages.map((m: { role: string; content: { type: string }[] }) => [m.role, m.content.map((c) => c.type)]), [
      ['user', ['text']],
      ['assistant', ['tool_use', 'tool_use']],
      ['user', ['tool_result', 'tool_result']],
    ]);
    assert.equal(seen.body!.messages[2].content[1].is_error, true);
  } finally {
    s.close();
  }
});

test('Anthropic: HTTP errors carry a hint', async () => {
  const s = await serve((_b, _r, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  });
  try {
    const p = anthropicProvider({ provider: 'anthropic', model: 'm', apiKey: 'bad', baseUrl: s.base });
    await assert.rejects(collect(p.stream({ system: '', messages: [{ role: 'user', content: 'x' }] })), /HTTP 401 invalid x-api-key \(check the API key\)/);
  } finally {
    s.close();
  }
  assert.deepEqual(anthropicMessages([{ role: 'assistant', content: '' }]), [{ role: 'assistant', content: [{ type: 'text', text: '…' }] }]);
});

test('OpenAI-compatible: streamed tool calls split across chunks, no key for local servers', async () => {
  let seen: { body?: Record<string, any>; auth?: string } = {};
  const s = await serve((body, req, res) => {
    seen = { body, auth: req.headers.authorization };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    chunk({ content: 'Turning it on.' });
    chunk({ tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'control_device', arguments: '{"target":"light.kit' } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'chen","action":"turn_on"}' } }] });
    chunk({}, 'tool_calls');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const p = openaiProvider({ provider: 'openai', model: 'qwen3:8b', baseUrl: `${s.base}/v1` });
    const events = await collect(
      p.stream({
        system: 'sys',
        messages: [
          { role: 'user', content: '开灯' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'home_overview', args: {} }] },
          { role: 'tool', toolCallId: 'x', name: 'home_overview', content: '{}' },
        ],
        tools: [{ name: 'control_device', description: 'c', parameters: { type: 'object' } }],
        toolChoice: 'control_device',
      }),
    );
    assert.deepEqual(events, [
      { type: 'text', text: 'Turning it on.' },
      { type: 'toolCall', call: { id: 'call_9', name: 'control_device', args: { target: 'light.kitchen', action: 'turn_on' } } },
      { type: 'done', stopReason: 'tool_calls' },
    ]);
    assert.equal(seen.auth, undefined);
    assert.deepEqual(seen.body!.messages.map((m: { role: string }) => m.role), ['system', 'user', 'assistant', 'tool']);
    assert.deepEqual(seen.body!.messages[2].tool_calls, [{ id: 'x', type: 'function', function: { name: 'home_overview', arguments: '{}' } }]);
    assert.deepEqual(seen.body!.tool_choice, { type: 'function', function: { name: 'control_device' } });
  } finally {
    s.close();
  }
});

/** A provider that plays back scripted turns and records what it was sent. */
function scripted(turns: StreamEvent[][]): LlmProvider & { requests: { messages: ChatMessage[]; tools?: string[] }[] } {
  const requests: { messages: ChatMessage[]; tools?: string[] }[] = [];
  return {
    name: 'test',
    model: 'test',
    requests,
    async *stream(req) {
      requests.push({ messages: structuredClone(req.messages), tools: req.tools?.map((t) => t.name) });
      for (const e of turns.shift() ?? [{ type: 'done', stopReason: 'end_turn' }]) yield e;
    },
  };
}

const toolbox: Toolbox = {
  tools: () => [
    { name: 'list_devices', description: 'l', inputSchema: { type: 'object' } },
    { name: 'control_device', description: 'c', inputSchema: { type: 'object' } },
    { name: 'propose_automation', description: 'p', inputSchema: { type: 'object' } },
  ],
  async call(name, args) {
    if (name === 'list_devices') return { content: [{ type: 'text', text: JSON.stringify([{ entityId: 'light.hall', name: 'Hall light' }]) }] };
    if (name === 'control_device' && args.action === 'unlock') return { content: [{ type: 'text', text: JSON.stringify({ ok: false, pending_confirmation: 'conf-1' }) }] };
    return { isError: true, content: [{ type: 'text', text: 'No device matches "garage"' }] };
  },
  visible: (d) => d,
};

const validate = (c: unknown) => {
  const cfg = c as { triggers?: unknown[] };
  return cfg.triggers?.length ? { ok: true, errors: [], warnings: [] } : { ok: false, errors: ['triggers: at least one trigger is required'] };
};

test('assistant loop: tools, confirmations, automation drafts with a validation retry', async () => {
  const tc = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: 'toolCall', call: { id, name, args } });
  const provider = scripted([
    [{ type: 'text', text: '我先看看设备。' }, tc('1', 'list_devices', {}), { type: 'done', stopReason: 'tool_use' }],
    [tc('2', 'control_device', { target: 'front door', action: 'unlock' }), tc('3', 'control_device', { target: 'garage', action: 'turn_on' }), { type: 'done', stopReason: 'tool_use' }],
    [tc('4', 'draft_automation', { automation: { alias: 'Hall at night', actions: [] } }), { type: 'done', stopReason: 'tool_use' }],
    [tc('5', 'draft_automation', { automation: { alias: 'Hall at night', triggers: [{ trigger: 'sun', event: 'sunset' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.hall' } }] } }), { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', text: '已生成草稿：日落时打开走廊灯。' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const events: AssistantEvent[] = [];
  for await (const e of runAssistant({ provider, toolbox, validateAutomation: validate, lang: 'zh', timezone: 'Asia/Shanghai' }, [], '日落后开走廊灯，顺便开门')) events.push(e);

  assert.deepEqual(provider.requests[0]!.tools, ['list_devices', 'control_device', 'draft_automation'], 'propose_automation is replaced by draft_automation');
  const results = events.filter((e) => e.type === 'toolResult') as Extract<AssistantEvent, { type: 'toolResult' }>[];
  assert.deepEqual(results.map((r) => [r.name, r.ok, r.pendingConfirmation]), [
    ['list_devices', true, undefined],
    ['control_device', true, 'conf-1'],
    ['control_device', false, undefined],
    ['draft_automation', false, undefined],
    ['draft_automation', true, undefined],
  ]);
  const drafts = events.filter((e) => e.type === 'automation') as Extract<AssistantEvent, { type: 'automation' }>[];
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.config.alias, 'Hall at night');
  // The model saw the validation error and fixed it.
  const fourth = provider.requests[3]!.messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
  assert.equal(fourth.isError, true);
  assert.match(fourth.content, /at least one trigger/);
  const done = events.at(-1) as Extract<AssistantEvent, { type: 'done' }>;
  assert.equal(done.messages[0]!.role, 'user');
  assert.equal((done.messages.at(-1) as Extract<ChatMessage, { role: 'assistant' }>).content, '已生成草稿：日落时打开走廊灯。');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), '我先看看设备。已生成草稿：日落时打开走廊灯。');
});

test('natural language → automation: retries until valid, nothing saved', async () => {
  const submit = (automation: unknown): StreamEvent[] => [{ type: 'toolCall', call: { id: 's', name: 'submit_automation', args: { automation, explanation: '日落时开走廊灯' } } }, { type: 'done', stopReason: 'tool_use' }];
  const provider = scripted([submit({ alias: 'x', actions: [] }), submit({ alias: 'x', triggers: [{ trigger: 'sun', event: 'sunset' }], actions: [] })]);
  const r = await generateAutomation({ provider, description: '日落时开走廊灯', context: 'Entities:\n- light.hall', validate });
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.errors, []);
  assert.equal(r.explanation, '日落时开走廊灯');
  assert.deepEqual((r.config as { triggers: unknown[] }).triggers, [{ trigger: 'sun', event: 'sunset' }]);

  const stubborn = scripted([submit({}), submit({}), submit({})]);
  const bad = await generateAutomation({ provider: stubborn, description: 'x', context: '', validate });
  assert.equal(bad.attempts, 3);
  assert.match(bad.errors[0]!, /trigger/);
});
