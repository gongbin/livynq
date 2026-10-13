import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { PeerCertificate } from 'node:tls';

/**
 * Philips Hue bridge, local CLIP v2 API (https://<bridge>/clip/v2/…) plus the server-sent
 * event stream. Bridges use a certificate signed by Signify's private CA with the bridge id as
 * common name; we check that name instead of the CA (trust on first use of the bridge id).
 * `host` may be "http://127.0.0.1:1234" for tests.
 */

export interface HueResource {
  id: string;
  type: string;
  owner?: { rid: string; rtype: string };
  [key: string]: unknown;
}

export interface HueEvent {
  type: 'update' | 'add' | 'delete' | 'error';
  data: HueResource[];
}

export class HueError extends Error {
  readonly status?: number;
  readonly hueType?: number;
  constructor(message: string, status?: number, hueType?: number) {
    super(message);
    this.status = status;
    this.hueType = hueType;
  }
}

interface Target {
  host: string;
  /** Expected certificate common name (bridge id, lowercase); unchecked when unknown. */
  bridgeId?: string;
  key?: string;
}

function options(t: Target, method: string, path: string, headers: Record<string, string>): { secure: boolean; opts: RequestOptions } {
  const url = new URL(/^https?:\/\//.test(t.host) ? t.host : `https://${t.host}`);
  const secure = url.protocol === 'https:';
  const opts: RequestOptions = {
    method,
    hostname: url.hostname,
    port: url.port || (secure ? 443 : 80),
    path,
    headers: { ...(t.key ? { 'hue-application-key': t.key } : {}), ...headers },
  };
  if (secure) {
    opts.rejectUnauthorized = false;
    opts.checkServerIdentity = (_host: string, cert: PeerCertificate) => {
      const cn = String(cert.subject?.CN ?? '').toLowerCase();
      return t.bridgeId && cn !== t.bridgeId.toLowerCase() ? new Error(`certificate is for ${cn || 'an unknown device'}, expected Hue bridge ${t.bridgeId}`) : undefined;
    };
  }
  return { secure, opts };
}

export function hueRequest<T>(t: Target, method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { secure, opts } = options(t, method, path, payload ? { 'content-type': 'application/json' } : {});
  return new Promise<T>((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          return reject(new HueError(`Unexpected reply from ${t.host} (HTTP ${res.statusCode})`, res.statusCode));
        }
        if ((res.statusCode ?? 500) >= 400) {
          const errors = (json as { errors?: { description: string }[] } | undefined)?.errors;
          const msg = res.statusCode === 403 || res.statusCode === 401 ? 'the bridge rejected the application key (pair again)' : errors?.map((e) => e.description).join('; ') || `HTTP ${res.statusCode}`;
          return reject(new HueError(`${t.host}: ${msg}`, res.statusCode));
        }
        resolve(json as T);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new HueError(`${t.host}: no answer`)));
    req.on('error', (err) => reject(err instanceof HueError ? err : new HueError(`${t.host}: ${err.message}`)));
    req.end(payload);
  });
}

/** Unauthenticated: bridge id, name, model (works on every bridge firmware). */
export async function bridgeConfig(host: string): Promise<{ bridgeId: string; name: string; modelId?: string; swversion?: string }> {
  const c = await hueRequest<{ bridgeid?: string; name?: string; modelid?: string; swversion?: string }>({ host }, 'GET', '/api/0/config', undefined, 5000);
  if (!c?.bridgeid) throw new HueError(`${host} is not a Hue bridge`);
  return { bridgeId: c.bridgeid.toLowerCase(), name: c.name ?? 'Hue Bridge', modelId: c.modelid, swversion: c.swversion };
}

/** Creates an application key. Throws a HueError with hueType 101 until the link button is pressed. */
export async function createKey(target: Target, deviceType: string): Promise<string> {
  const res = await hueRequest<{ success?: { username: string }; error?: { type: number; description: string } }[]>(target, 'POST', '/api', { devicetype: deviceType, generateclientkey: true });
  const first = res?.[0];
  if (first?.success?.username) return first.success.username;
  const e = first?.error;
  throw new HueError(e?.type === 101 ? 'Press the round link button on the Hue bridge, then try again within 30 seconds' : (e?.description ?? 'pairing failed'), undefined, e?.type);
}

/** Events: 'open', 'events' (HueEvent[]), 'close', 'error' (Error). Reconnects until closed. */
export class HueEventStream extends EventEmitter {
  #target: Target;
  #res: IncomingMessage | undefined;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(target: Target) {
    super();
    this.#target = target;
  }

  connect(): void {
    if (this.#closed) return;
    const { secure, opts } = options(this.#target, 'GET', '/eventstream/clip/v2', { accept: 'text/event-stream' });
    const req = (secure ? httpsRequest : httpRequest)(opts, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        res.resume();
        this.emit('error', new HueError(`event stream: HTTP ${res.statusCode}`, res.statusCode));
        return this.#retry();
      }
      this.#res = res;
      this.emit('open');
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            this.emit('events', JSON.parse(data) as HueEvent[]);
          } catch {
            // keep-alive or a malformed chunk
          }
        }
      });
      res.on('close', () => {
        this.#res = undefined;
        this.emit('close');
        this.#retry();
      });
    });
    req.on('error', (err) => {
      this.emit('error', err);
      this.#retry();
    });
    req.end();
  }

  #retry(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.connect();
    }, 5000);
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#res?.destroy();
  }
}
