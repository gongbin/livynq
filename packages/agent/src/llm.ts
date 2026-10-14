/**
 * Chat models for Livynq's built-in assistant, without SDK dependencies:
 *   - "anthropic": Claude through the Messages API
 *   - "openai": any OpenAI-compatible Chat Completions API — OpenAI, DeepSeek, Qwen (DashScope),
 *     Moonshot / Kimi, Zhipu GLM, and local servers such as Ollama or LM Studio.
 * Both stream; tool calls are normalised into one message format.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema of the arguments */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Force a specific tool (structured output) */
  toolChoice?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'done'; stopReason: string; usage?: { input?: number; output?: number } };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export interface LlmSettings {
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey?: string;
  /** API base URL: https://api.anthropic.com, https://api.openai.com/v1, http://localhost:11434/v1 … */
  baseUrl?: string;
}

export class LlmError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Presets shown in the UI; models are suggestions, any model id works. */
export const LLM_PRESETS = [
  { id: 'claude', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', needsKey: true },
  { id: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', needsKey: true },
  { id: 'deepseek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  { id: 'qwen', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true },
  { id: 'moonshot', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-turbo-preview', needsKey: true },
  { id: 'zhipu', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', needsKey: true },
  { id: 'ollama', provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', needsKey: false },
] as const;

/** Parses a server-sent event stream into data payloads. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { ...(event ? { event } : {}), data: data.join('\n') };
    }
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new LlmError(`cannot reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? message;
    } catch {
      // not JSON
    }
    const hint = res.status === 401 || res.status === 403 ? ' (check the API key)' : res.status === 404 ? ' (check the model name and base URL)' : res.status === 429 ? ' (rate limited or out of credit)' : '';
    throw new LlmError(`${new URL(url).host}: HTTP ${res.status} ${message}${hint}`, res.status);
  }
  return res;
}

const safeJson = (s: string): Record<string, unknown> => {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { _invalid: s };
  }
};

// ---------------------------------------------------------------- Anthropic

export function anthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', { type: 'text', text: m.content });
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args });
      if (!m.content && !m.toolCalls?.length) push('assistant', { type: 'text', text: '…' });
    } else push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) });
  }
  return out;
}

export function anthropicProvider(s: LlmSettings): LlmProvider {
  const base = (s.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    name: 'anthropic',
    model: s.model,
    async *stream(req) {
      const res = await post(
        `${base}/v1/messages`,
        { 'x-api-key': s.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        {
          model: s.model,
          max_tokens: req.maxTokens ?? 2048,
          system: req.system,
          messages: anthropicMessages(req.messages),
          stream: true,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
          ...(req.toolChoice ? { tool_choice: { type: 'tool', name: req.toolChoice } } : {}),
        },
        req.signal,
      );
      const blocks = new Map<number, { id: string; name: string; json: string }>();
      let stopReason = 'end_turn';
      const usage: { input?: number; output?: number } = {};
      for await (const { data } of sse(res.body!)) {
        const e = JSON.parse(data) as Record<string, any>;
        switch (e.type) {
          case 'message_start':
            usage.input = e.message?.usage?.input_tokens;
            break;
          case 'content_block_start':
            if (e.content_block?.type === 'tool_use') blocks.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: '' });
            break;
          case 'content_block_delta':
            if (e.delta?.type === 'text_delta') yield { type: 'text', text: e.delta.text };
            else if (e.delta?.type === 'input_json_delta') {
              const b = blocks.get(e.index);
              if (b) b.json += e.delta.partial_json;
            }
            break;
          case 'content_block_stop': {
            const b = blocks.get(e.index);
            if (b) {
              blocks.delete(e.index);
              yield { type: 'toolCall', call: { id: b.id, name: b.name, args: safeJson(b.json) } };
            }
            break;
          }
          case 'message_delta':
            stopReason = e.delta?.stop_reason ?? stopReason;
            usage.output = e.usage?.output_tokens;
            break;
          case 'error':
            throw new LlmError(`anthropic: ${e.error?.message ?? 'stream error'}`);
        }
      }
      yield { type: 'done', stopReason, usage };
    },
  };
}

// ---------------------------------------------------------------- OpenAI-compatible

export function openaiMessages(system: string, messages: ChatMessage[]): unknown[] {
  return [
    { role: 'system', content: system },
    ...messages.map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.content }
        : m.role === 'assistant'
          ? {
              role: 'assistant',
              content: m.content || null,
              ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
            }
          : { role: 'tool', tool_call_id: m.toolCallId, content: m.isError ? `Error: ${m.content}` : m.content },
    ),
  ];
}

export function openaiProvider(s: LlmSettings): LlmProvider {
  const base = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    name: 'openai',
    model: s.model,
    async *stream(req) {
      const res = await post(
        `${base}/chat/completions`,
        s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {},
        {
          model: s.model,
          messages: openaiMessages(req.system, req.messages),
          stream: true,
          max_tokens: req.maxTokens ?? 2048,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
          ...(req.toolChoice ? { tool_choice: { type: 'function', function: { name: req.toolChoice } } } : {}),
        },
        req.signal,
      );
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let stopReason = 'stop';
      let usage: { input?: number; output?: number } | undefined;
      for await (const { data } of sse(res.body!)) {
        if (data === '[DONE]') break;
        const e = JSON.parse(data) as Record<string, any>;
        if (e.error) throw new LlmError(`${new URL(base).host}: ${e.error.message ?? 'stream error'}`);
        if (e.usage) usage = { input: e.usage.prompt_tokens, output: e.usage.completion_tokens };
        const choice = e.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }
      for (const [i, c] of [...calls].sort((a, b) => a[0] - b[0])) yield { type: 'toolCall', call: { id: c.id || `call_${i}`, name: c.name, args: safeJson(c.args) } };
      yield { type: 'done', stopReason, ...(usage ? { usage } : {}) };
    },
  };
}

export function createProvider(s: LlmSettings): LlmProvider {
  if (!s.model) throw new LlmError('No model configured');
  return s.provider === 'anthropic' ? anthropicProvider(s) : openaiProvider(s);
}
