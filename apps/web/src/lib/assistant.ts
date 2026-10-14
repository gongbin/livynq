import type { ApiErrorBody } from '@livynq/model';
import { auth, ApiError } from './api.ts';
import { createStore, useStore } from './store.ts';

/** Client for the built-in assistant (apps/server/src/routes/assistant.ts). */

export interface LlmPreset {
  id: string;
  provider: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  needsKey: boolean;
}

export interface AssistantSettings {
  configured: boolean;
  preset: string | null;
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  presets: LlmPreset[];
}

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'toolResult'; id: string; name: string; ok: boolean; pendingConfirmation?: string }
  | { type: 'automation'; config: Record<string, unknown>; warnings: string[] }
  | { type: 'done'; messages: ChatMessage[] }
  | { type: 'error'; message: string };

export interface GeneratedAutomation {
  config: Record<string, unknown> | null;
  explanation: string;
  errors: string[];
  warnings: string[];
  attempts: number;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${auth.get() ?? ''}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, (data as ApiErrorBody | undefined)?.error ?? { code: `HTTP_${res.status}`, message: res.statusText });
  return data as T;
}

export const assistantApi = {
  settings: () => call<AssistantSettings>('GET', '/assistant/settings'),
  save: (s: { provider: string; model: string; baseUrl?: string; apiKey?: string | null; preset?: string }) => call<AssistantSettings>('PUT', '/assistant/settings', s),
  test: (s?: { provider: string; model: string; baseUrl?: string; apiKey?: string }) => call<{ ok: boolean; reply?: string; error?: string; ms: number }>('POST', '/assistant/test', s ?? {}),
  generateAutomation: (description: string, lang: string, current?: Record<string, unknown>) => call<GeneratedAutomation>('POST', '/assistant/automation', { description, lang, ...(current ? { current } : {}) }),
  proposeAutomation: (config: Record<string, unknown>) => call<{ id: string }>('POST', '/automations/proposals', config),
};

/** Streams one assistant turn (server-sent events over a POST). */
export async function* chat(message: string, history: ChatMessage[], lang: string, signal: AbortSignal): AsyncGenerator<AssistantEvent> {
  const res = await fetch('/api/v1/assistant/chat', {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.get() ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message, history, lang }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiError(res.status, data?.error ?? { code: `HTTP_${res.status}`, message: res.statusText });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (block.startsWith('data: ')) yield JSON.parse(block.slice(6)) as AssistantEvent;
    }
  }
}

// ---------------------------------------------------------------- conversation (survives navigation)

export interface ChatItem {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'automation' | 'error';
  text?: string;
  tool?: { name: string; args: Record<string, unknown>; status: 'running' | 'ok' | 'error' | 'pending'; confirmation?: string };
  automation?: { config: Record<string, unknown>; warnings: string[]; savedId?: string };
}

interface Conversation {
  items: ChatItem[];
  history: ChatMessage[];
  busy: boolean;
}

export const conversation = createStore<Conversation>({ items: [], history: [], busy: false });
export const useConversation = () => useStore(conversation);
let seq = 0;
let abort: AbortController | null = null;

export function resetConversation(): void {
  abort?.abort();
  conversation.set({ items: [], history: [], busy: false });
}

export function stopAssistant(): void {
  abort?.abort();
}

export async function send(text: string, lang: string): Promise<void> {
  const message = text.trim();
  if (!message || conversation.get().busy) return;
  abort = new AbortController();
  const { history } = conversation.get();
  conversation.set((c) => ({ ...c, busy: true, items: [...c.items, { id: ++seq, kind: 'user', text: message }] }));
  let current: number | null = null;
  const update = (fn: (items: ChatItem[]) => ChatItem[]) => conversation.set((c) => ({ ...c, items: fn(c.items) }));
  try {
    for await (const e of chat(message, history, lang, abort.signal)) {
      if (e.type === 'text') {
        if (current === null) {
          const id = ++seq;
          current = id;
          update((items) => [...items, { id, kind: 'assistant', text: e.text }]);
        } else {
          const id = current;
          update((items) => items.map((it) => (it.id === id ? { ...it, text: (it.text ?? '') + e.text } : it)));
        }
      } else if (e.type === 'tool') {
        current = null;
        if (e.name === 'draft_automation') continue;
        update((items) => [...items, { id: ++seq, kind: 'tool', tool: { name: e.name, args: e.args, status: 'running' }, text: e.id }]);
      } else if (e.type === 'toolResult') {
        if (e.name === 'draft_automation') continue;
        update((items) =>
          items.map((it) => (it.kind === 'tool' && it.text === e.id ? { ...it, tool: { ...it.tool!, status: e.pendingConfirmation ? 'pending' : e.ok ? 'ok' : 'error', ...(e.pendingConfirmation ? { confirmation: e.pendingConfirmation } : {}) } } : it)),
        );
      } else if (e.type === 'automation') {
        current = null;
        update((items) => [...items, { id: ++seq, kind: 'automation', automation: { config: e.config, warnings: e.warnings } }]);
      } else if (e.type === 'error') {
        update((items) => [...items, { id: ++seq, kind: 'error', text: e.message }]);
      } else if (e.type === 'done') {
        conversation.set((c) => ({ ...c, history: [...c.history, ...e.messages].slice(-60) }));
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') update((items) => [...items, { id: ++seq, kind: 'error', text: err instanceof ApiError ? err.message : (err as Error).message }]);
  } finally {
    conversation.set((c) => ({ ...c, busy: false }));
    abort = null;
  }
}

export function markSaved(itemId: number, savedId: string): void {
  conversation.set((c) => ({ ...c, items: c.items.map((it) => (it.id === itemId && it.automation ? { ...it, automation: { ...it.automation, savedId } } : it)) }));
}

// ---------------------------------------------------------------- hand-off to the automation editor

const DRAFT_KEY = 'livynq.automationDraft';

export function openDraftInEditor(config: Record<string, unknown>): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(config));
  } catch {
    // private mode: the editor then starts blank
  }
  location.hash = '/automations/new?draft=1';
}

export function takeDraft(): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

