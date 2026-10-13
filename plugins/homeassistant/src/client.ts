/**
 * Minimal Home Assistant WebSocket API client on Node's built-in WebSocket:
 * auth, request/response by id, event subscriptions, reconnect with backoff.
 */
export interface HaClientOptions {
  /** http(s)://host:8123 or ws(s)://…/api/websocket */
  url: string;
  token: string;
  onConnected(): void | Promise<void>;
  onDisconnected(reason: string): void;
  onEvent(event: { event_type: string; data: Record<string, unknown> }): void;
  log(message: string): void;
  /** For tests. */
  backoffMs?: number[];
}

export function websocketUrl(url: string): string {
  if (/^wss?:\/\//.test(url)) return url;
  const u = new URL(url);
  const base = u.pathname.replace(/\/$/, '');
  // Supervisor add-on proxy: http://supervisor/core → ws://supervisor/core/websocket
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}${base}${base.endsWith('/core') ? '/websocket' : '/api/websocket'}`;
}

export class HaClient {
  readonly #opts: HaClientOptions;
  #ws: WebSocket | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #authed = false;

  constructor(opts: HaClientOptions) {
    this.#opts = opts;
  }

  get connected(): boolean {
    return this.#authed;
  }

  connect(): void {
    if (this.#closed) return;
    const ws = new WebSocket(websocketUrl(this.#opts.url));
    this.#ws = ws;
    ws.addEventListener('message', (ev) => void this.#onMessage(String(ev.data)));
    ws.addEventListener('close', () => this.#onClose('connection closed'));
    ws.addEventListener('error', () => this.#onClose('connection error'));
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
  }

  /** Sends a command and resolves with its `result`. */
  send<T = unknown>(command: Record<string, unknown>): Promise<T> {
    if (!this.#authed || !this.#ws) return Promise.reject(new Error('Home Assistant is not connected'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws!.send(JSON.stringify({ ...command, id }));
    });
  }

  async #onMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'auth_required':
        this.#ws?.send(JSON.stringify({ type: 'auth', access_token: this.#opts.token }));
        return;
      case 'auth_invalid':
        this.#opts.log(`Home Assistant rejected the access token: ${String(msg.message ?? '')}`);
        this.#closed = true; // retrying a bad token is pointless
        this.#ws?.close();
        return;
      case 'auth_ok':
        this.#authed = true;
        this.#attempt = 0;
        this.#opts.log(`connected to Home Assistant ${String(msg.ha_version ?? '')}`);
        try {
          await this.#opts.onConnected();
        } catch (err) {
          this.#opts.log(`initial sync failed: ${(err as Error).message}`);
          this.#ws?.close();
        }
        return;
      case 'result': {
        const p = this.#pending.get(Number(msg.id));
        if (!p) return;
        this.#pending.delete(Number(msg.id));
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error(String((msg.error as { message?: string } | undefined)?.message ?? 'Home Assistant error')));
        return;
      }
      case 'event':
        this.#opts.onEvent(msg.event as { event_type: string; data: Record<string, unknown> });
        return;
    }
  }

  #onClose(reason: string): void {
    if (!this.#ws) return;
    this.#ws = undefined;
    const wasAuthed = this.#authed;
    this.#authed = false;
    for (const p of this.#pending.values()) p.reject(new Error('Home Assistant connection lost'));
    this.#pending.clear();
    if (wasAuthed) this.#opts.onDisconnected(reason);
    if (this.#closed) return;
    const backoff = this.#opts.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
    const delay = backoff[Math.min(this.#attempt++, backoff.length - 1)]!;
    this.#timer = setTimeout(() => this.connect(), delay);
  }
}
