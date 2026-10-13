import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * Shelly Gen2+ RPC over WebSocket (ws://host/rpc). Notifications (NotifyStatus, NotifyEvent,
 * NotifyFullStatus) arrive on the same socket once the client has sent a request with a `src`.
 * Password-protected devices answer 401 with a digest challenge (SHA-256).
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function digestAuth(challenge: { realm: string; nonce: number | string; nc?: number }, password: string, cnonce = randomBytes(8).readUInt32BE(0)) {
  const ha1 = sha256(`admin:${challenge.realm}:${password}`);
  const ha2 = sha256('dummy_method:dummy_uri');
  const nc = challenge.nc ?? 1;
  return { realm: challenge.realm, username: 'admin', nonce: challenge.nonce, cnonce, response: sha256(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`), algorithm: 'SHA-256' };
}

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Pending = { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: Error) => void; authTried: boolean; timer: NodeJS.Timeout };

export interface ShellyConnectionOptions {
  host: string;
  password?: string;
  /** Client id sent as `src` (notifications are addressed to it). */
  src: string;
  reconnectMs?: number;
  timeoutMs?: number;
}

/** Events: 'open', 'close', 'notify' (method, params), 'error' (Error) */
export class ShellyConnection extends EventEmitter {
  readonly #o: Required<Omit<ShellyConnectionOptions, 'password'>> & { password?: string };
  #ws: WebSocket | undefined;
  #id = 0;
  #pending = new Map<number, Pending>();
  #auth: { realm: string; nonce: number | string; nc?: number } | undefined;
  #closed = false;
  #retry: NodeJS.Timeout | undefined;

  constructor(options: ShellyConnectionOptions) {
    super();
    this.#o = { reconnectMs: 15_000, timeoutMs: 10_000, ...options };
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.#closed = false;
    const host = this.#o.host.includes(':') && !this.#o.host.startsWith('[') && this.#o.host.split(':').length > 2 ? `[${this.#o.host}]` : this.#o.host;
    const ws = new WebSocket(`ws://${host}/rpc`);
    this.#ws = ws;
    ws.addEventListener('open', () => this.emit('open'));
    ws.addEventListener('message', (e) => this.#onMessage(String(e.data)));
    ws.addEventListener('error', () => this.emit('error', new Error(`cannot connect to ${this.#o.host}`)));
    ws.addEventListener('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('connection closed'));
      }
      this.#pending.clear();
      this.emit('close');
      if (!this.#closed) this.#retry = setTimeout(() => this.connect(), this.#o.reconnectMs);
    });
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#retry);
    this.#ws?.close();
    this.#ws = undefined;
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.#id;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer from ${this.#o.host}`));
      }, this.#o.timeoutMs);
      this.#pending.set(id, { method, params, resolve: resolve as (v: unknown) => void, reject, authTried: false, timer });
      this.#send(id);
    });
  }

  #send(id: number): void {
    const p = this.#pending.get(id)!;
    if (!this.connected) {
      clearTimeout(p.timer);
      this.#pending.delete(id);
      return p.reject(new Error(`${this.#o.host} is not connected`));
    }
    const auth = this.#auth && this.#o.password ? { auth: digestAuth(this.#auth, this.#o.password) } : {};
    this.#ws!.send(JSON.stringify({ id, src: this.#o.src, method: p.method, params: p.params, ...auth }));
  }

  #onMessage(text: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.method && msg.id === undefined) return void this.emit('notify', msg.method, msg.params ?? {});
    const p = msg.id === undefined ? undefined : this.#pending.get(msg.id);
    if (!p) return;
    if (msg.error?.code === 401 && !p.authTried && this.#o.password) {
      try {
        this.#auth = JSON.parse(msg.error.message);
        p.authTried = true;
        return this.#send(msg.id!);
      } catch {
        // fall through to the error
      }
    }
    clearTimeout(p.timer);
    this.#pending.delete(msg.id!);
    if (msg.error) {
      const hint = msg.error.code === 401 ? (this.#o.password ? 'wrong password' : 'password required') : msg.error.message;
      p.reject(new RpcError(msg.error.code, `${p.method}: ${hint}`));
    } else p.resolve(msg.result);
  }
}
