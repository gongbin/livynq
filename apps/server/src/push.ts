import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Confirmation, Home, HomeNotification, TokenScope } from '@livynq/core';

/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), using
 * only node:crypto. Browsers (Chrome, Firefox, Safari / iOS home-screen apps) hand us an endpoint
 * on their push service plus the keys to encrypt for; the hub never talks to a Livynq cloud.
 */

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

export interface Vapid {
  publicKey: string; // base64url, uncompressed P-256 point (what PushManager.subscribe wants)
  privateKey: KeyObject;
}

/** Loads or creates the hub's VAPID key pair (secrets/vapid.json, 0600). */
export function loadVapid(dataDir: string): Vapid {
  const file = dataDir === ':memory:' ? undefined : join(dataDir, 'secrets', 'vapid.json');
  if (file && existsSync(file)) {
    const jwk = JSON.parse(readFileSync(file, 'utf8')) as JsonWebKey;
    const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
    return { privateKey, publicKey: rawPublic(privateKey) };
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  if (file) {
    mkdirSync(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(privateKey.export({ format: 'jwk' })), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return { privateKey, publicKey: rawPublic(privateKey) };
}

function rawPublic(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string; y: string };
  return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
}

/** VAPID Authorization header for a push service origin. */
export function vapidHeader(vapid: Vapid, endpoint: string, subject: string, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/** RFC 8291 aes128gcm body for one subscription (single record). */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string, salt = randomBytes(16)): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Device label shown in settings, e.g. "iPhone" */
  name: string;
  /** Token that subscribed: revoking it stops the pushes; its scope decides what it receives. */
  tokenId: string;
  tokenName: string;
  createdAt: number;
  lastError?: string;
}

const KEY = 'push.subscriptions';
const SUBJECT = 'https://github.com/gongbin/livynq';

export class PushService {
  readonly vapid: Vapid;
  readonly #home: Home;
  readonly #fetch: typeof fetch;

  constructor(home: Home, options: { fetch?: typeof fetch } = {}) {
    this.#home = home;
    this.vapid = loadVapid(home.dataDir);
    this.#fetch = options.fetch ?? fetch;
  }

  list(): PushSubscriptionRecord[] {
    return this.#home.settings.get<PushSubscriptionRecord[]>(KEY, []);
  }

  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, who: { id: string; name: string }, name: string): PushSubscriptionRecord {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('push endpoint must be https');
    if (Buffer.from(sub.keys.p256dh, 'base64url').length !== 65 || Buffer.from(sub.keys.auth, 'base64url').length !== 16) throw new Error('invalid subscription keys');
    const record: PushSubscriptionRecord = { endpoint: sub.endpoint, keys: sub.keys, name: name.slice(0, 60) || 'Browser', tokenId: who.id, tokenName: who.name, createdAt: Date.now() };
    this.#save([...this.list().filter((s) => s.endpoint !== sub.endpoint), record]);
    return record;
  }

  unsubscribe(endpoint: string): boolean {
    const before = this.list();
    const after = before.filter((s) => s.endpoint !== endpoint);
    this.#save(after);
    return after.length !== before.length;
  }

  #save(list: PushSubscriptionRecord[]): void {
    this.#home.settings.set(KEY, list);
  }

  /** Sends to every matching subscription; dead ones (404/410) are dropped. */
  async send(n: HomeNotification, filter: (s: PushSubscriptionRecord, scope: TokenScope) => boolean = () => true): Promise<{ sent: number; failed: number }> {
    const scopes = new Map(this.#home.tokens.list().map((t) => [t.id, t.scope]));
    const subs = this.list().filter((s) => scopes.has(s.tokenId) && filter(s, scopes.get(s.tokenId)!));
    const payload = Buffer.from(JSON.stringify({ id: n.id, title: n.title ?? 'Livynq', body: n.message, url: n.url ?? '/', tag: n.tag, kind: n.kind, ts: n.ts }));
    let sent = 0;
    const gone: string[] = [];
    const errors = new Map<string, string>();
    await Promise.all(
      subs.map(async (s) => {
        try {
          const res = await this.#fetch(s.endpoint, {
            method: 'POST',
            headers: {
              authorization: vapidHeader(this.vapid, s.endpoint, SUBJECT),
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              ttl: String(n.kind === 'confirmation' ? 600 : 86_400),
              urgency: n.kind === 'confirmation' ? 'high' : 'normal',
              ...(n.tag ? { topic: n.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'livynq' } : {}),
            },
            body: encryptPayload(payload, s.keys.p256dh, s.keys.auth),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
          else if (!res.ok) errors.set(s.endpoint, `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
          else sent++;
        } catch (err) {
          errors.set(s.endpoint, (err as Error).message);
        }
      }),
    );
    // Drop dead subscriptions and remember the last error per device (shown in settings).
    if (gone.length || errors.size || subs.some((s) => s.lastError)) {
      const tried = new Set(subs.map((s) => s.endpoint));
      this.#save(
        this.list()
          .filter((s) => !gone.includes(s.endpoint))
          .map((s) => {
            if (!tried.has(s.endpoint)) return s;
            const { lastError: _previous, ...rest } = s;
            const e = errors.get(s.endpoint);
            return e ? { ...rest, lastError: e } : rest;
          }),
      );
    }
    if (errors.size) this.#home.log.warn({ failed: errors.size }, 'push delivery failed');
    return { sent, failed: errors.size };
  }

  /** Pushes hub notifications and approval requests (admins only) as they happen. */
  start(): () => void {
    const offs = [
      this.#home.bus.on('notification', (n) => {
        void this.send(n, (_s, scope) => n.kind !== 'confirmation' || scope === 'admin');
      }),
      this.#home.bus.on('confirmation', (c: Confirmation) => {
        if (c.status !== 'pending') return;
        void this.send(
          { id: c.id, title: 'Approval needed', message: `${c.requestedBy}: ${c.summary}`, url: '/', tag: `confirm-${c.id}`, kind: 'confirmation', source: 'confirmations', ts: Date.now() },
          (_s, scope) => scope === 'admin',
        );
      }),
    ];
    return () => offs.forEach((off) => off());
  }
}
