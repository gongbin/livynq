import type { CameraSource } from '@livynq/model';
import { Authenticator } from './auth.ts';

/**
 * JPEG stills from the camera's snapshot URL (ONVIF GetSnapshotUri), with Basic / Digest auth and
 * a short per-camera cache so several dashboards refreshing at once cost one request.
 */

export class SnapshotError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface Snapshot {
  contentType: string;
  data: Buffer;
  at: number;
}

export class SnapshotCache {
  readonly #ttlMs: number;
  readonly #fetch: typeof fetch;
  readonly #cache = new Map<string, Snapshot>();
  readonly #inflight = new Map<string, Promise<Snapshot>>();

  constructor(options: { ttlMs?: number; fetch?: typeof fetch } = {}) {
    this.#ttlMs = options.ttlMs ?? 4000;
    this.#fetch = options.fetch ?? fetch;
  }

  async get(key: string, source: CameraSource | undefined): Promise<Snapshot> {
    if (!source) throw new SnapshotError('No stream source for this camera (is its integration running?)', 404);
    if (!source.snapshotUrl) throw new SnapshotError('This camera has no snapshot URL; open the live view instead', 404);
    const cached = this.#cache.get(key);
    if (cached && Date.now() - cached.at < this.#ttlMs) return cached;
    let p = this.#inflight.get(key);
    if (!p) {
      p = this.#load(source).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, p);
    }
    const snap = await p;
    this.#cache.set(key, snap);
    return snap;
  }

  forget(key: string): void {
    this.#cache.delete(key);
  }

  async #load(source: CameraSource): Promise<Snapshot> {
    const url = source.snapshotUrl!;
    const auth = new Authenticator(source.username, source.password);
    const path = (() => {
      const u = new URL(url);
      return u.pathname + u.search;
    })();
    for (let attempt = 0; attempt < 2; attempt++) {
      const header = auth.header('GET', path);
      let res: Response;
      try {
        res = await this.#fetch(url, { headers: header ? { authorization: header } : {}, signal: AbortSignal.timeout(8000) });
      } catch (err) {
        throw new SnapshotError(`The camera did not answer (${(err as Error).message})`, 504);
      }
      if (res.status === 401 && attempt === 0 && auth.accept(res.headers.get('www-authenticate') ? [res.headers.get('www-authenticate')!] : [])) {
        await res.arrayBuffer().catch(() => {});
        continue;
      }
      if (res.status === 401) throw new SnapshotError('The camera rejected the snapshot credentials', 502);
      if (!res.ok) throw new SnapshotError(`The camera answered ${res.status}`, 502);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > 10 * 1024 * 1024) throw new SnapshotError('Snapshot too large', 502);
      const contentType = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
      if (!contentType.startsWith('image/')) throw new SnapshotError(`The camera returned ${contentType}, not an image`, 502);
      return { contentType, data, at: Date.now() };
    }
    throw new SnapshotError('Snapshot failed', 502);
  }
}
