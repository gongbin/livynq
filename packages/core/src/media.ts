import type { CameraSource, DeviceId } from '@livynq/model';

/**
 * Camera stream sources handed to the hub by adapters (ctx.media.register). Kept in memory only:
 * credentials are never persisted, never sent to clients and never logged; adapters register
 * again when they start.
 */
export interface MediaEntry {
  adapter: string;
  deviceId: DeviceId;
  endpointId: number;
  source: CameraSource;
}

export type MediaListener = (deviceId: DeviceId, endpointId: number, entry: MediaEntry | undefined) => void;

const key = (deviceId: DeviceId, endpointId: number) => `${deviceId}/${endpointId}`;

/** "rtsp://user:pass@host/x" → "rtsp://host/x", for logs and errors. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//');
  }
}

export class MediaRegistry {
  readonly #entries = new Map<string, MediaEntry>();
  readonly #listeners = new Set<MediaListener>();

  set(adapter: string, deviceId: DeviceId, endpointId: number, source: CameraSource): void {
    if (typeof source?.url !== 'string' || !/^rtsps?:\/\//i.test(source.url)) throw new Error('camera source url must be rtsp:// or rtsps://');
    if (source.snapshotUrl !== undefined && !/^https?:\/\//i.test(source.snapshotUrl)) throw new Error('snapshotUrl must be http(s)://');
    // Credentials embedded in the URL move to username/password so nothing downstream sees them.
    const u = new URL(source.url);
    const clean: CameraSource = {
      url: redactUrl(source.url),
      ...((source.username ?? decodeURIComponent(u.username)) ? { username: source.username ?? decodeURIComponent(u.username) } : {}),
      ...((source.password ?? decodeURIComponent(u.password)) ? { password: source.password ?? decodeURIComponent(u.password) } : {}),
      ...(source.snapshotUrl ? { snapshotUrl: source.snapshotUrl } : {}),
    };
    const entry: MediaEntry = { adapter, deviceId, endpointId, source: clean };
    const k = key(deviceId, endpointId);
    const prev = this.#entries.get(k);
    if (prev && JSON.stringify(prev.source) === JSON.stringify(clean) && prev.adapter === adapter) return;
    this.#entries.set(k, entry);
    for (const l of this.#listeners) l(deviceId, endpointId, entry);
  }

  delete(deviceId: DeviceId, endpointId?: number): void {
    for (const [k, e] of this.#entries) {
      if (e.deviceId !== deviceId || (endpointId !== undefined && e.endpointId !== endpointId)) continue;
      this.#entries.delete(k);
      for (const l of this.#listeners) l(e.deviceId, e.endpointId, undefined);
    }
  }

  /** Drops everything an adapter registered (plugin stopped, crashed or removed). */
  deleteAdapter(adapter: string): void {
    for (const e of [...this.#entries.values()]) if (e.adapter === adapter) this.delete(e.deviceId, e.endpointId);
  }

  get(deviceId: DeviceId, endpointId: number): MediaEntry | undefined {
    return this.#entries.get(key(deviceId, endpointId));
  }

  list(): MediaEntry[] {
    return [...this.#entries.values()];
  }

  onChange(listener: MediaListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
