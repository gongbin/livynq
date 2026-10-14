import { createHash, randomBytes } from 'node:crypto';

/**
 * Xiaomi account + Mi Home cloud API, used for two things only:
 *   1. a one-time QR login (scan with the Mi Home app) to read the device list with each
 *      device's LAN token, model and IP — afterwards Wi-Fi devices are controlled locally;
 *   2. optionally, devices that cannot be reached on the LAN (Bluetooth / Zigbee sub-devices of a
 *      Xiaomi gateway) are read and controlled through the cloud's MIoT property API.
 *
 * Requests use the Mi Home app's RC4 scheme: every parameter is RC4-encrypted with a key derived
 * from the session's ssecurity and a per-request nonce, and signed with SHA-1.
 */

export interface Session {
  userId: string;
  ssecurity: string;
  serviceToken: string;
  /** API region: cn, de, us, ru, sg, i2 (India) */
  country: string;
}

export interface CloudDevice {
  did: string;
  name: string;
  model: string;
  token?: string;
  localip?: string;
  mac?: string;
  isOnline?: boolean;
  parent_id?: string;
}

export class CloudError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- RC4 (not in OpenSSL 3's default provider)

function rc4(key: Buffer, data: Buffer, drop = 1024): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  let j = 0;
  for (let n = 0; n < drop + data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    const k = s[(s[i]! + s[j]!) & 255]!;
    if (n >= drop) out[n - drop] = data[n - drop]! ^ k;
  }
  return out;
}

export const rc4Encrypt = (signedNonce: string, text: string) => rc4(Buffer.from(signedNonce, 'base64'), Buffer.from(text, 'utf8')).toString('base64');
export const rc4Decrypt = (signedNonce: string, b64: string) => rc4(Buffer.from(signedNonce, 'base64'), Buffer.from(b64, 'base64')).toString('utf8');

export function nonce(now = Date.now()): string {
  const b = Buffer.alloc(12);
  randomBytes(8).copy(b, 0);
  b.writeUInt32BE(Math.floor(now / 60_000), 8);
  return b.toString('base64');
}

export const signedNonce = (ssecurity: string, n: string) =>
  createHash('sha256')
    .update(Buffer.concat([Buffer.from(ssecurity, 'base64'), Buffer.from(n, 'base64')]))
    .digest('base64');

/** SHA-1 over "POST&/path&k=v&…&signedNonce" (path without the /app prefix). */
export function encSignature(path: string, sn: string, params: [string, string][]): string {
  const parts = ['POST', path, ...params.map(([k, v]) => `${k}=${v}`), sn];
  return createHash('sha1').update(parts.join('&')).digest('base64');
}

/** Encrypted request parameters for one API call. */
export function encryptParams(ssecurity: string, path: string, params: Record<string, string>, n = nonce()): { fields: Record<string, string>; signedNonce: string } {
  const sn = signedNonce(ssecurity, n);
  const plain = Object.entries(params);
  const withHash: [string, string][] = [...plain, ['rc4_hash__', encSignature(path, sn, plain)]];
  const enc = withHash.map(([k, v]) => [k, rc4Encrypt(sn, v)] as [string, string]);
  const fields = Object.fromEntries([...enc, ['signature', encSignature(path, sn, enc)], ['ssecurity', ssecurity], ['_nonce', n]]);
  return { fields, signedNonce: sn };
}

const apiBase = (country: string) => `https://${country === 'cn' ? '' : `${country}.`}api.io.mi.com/app`;
const AGENT = `Android-13-8.8.6-Livynq APP/com.xiaomi.mihome APPV/10.5.201 ${randomBytes(6).toString('hex').toUpperCase()}`;

const stripStart = (text: string) => JSON.parse(text.replace(/^&&&START&&&/, '')) as Record<string, unknown>;

export class XiaomiCloud {
  readonly #fetch: typeof fetch;
  readonly #accountBase: string;
  readonly #apiBase?: string;
  session: Session | undefined;

  constructor(options: { fetch?: typeof fetch; accountBase?: string; apiBase?: string; session?: Session } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#accountBase = options.accountBase ?? 'https://account.xiaomi.com';
    this.#apiBase = options.apiBase;
    this.session = options.session;
  }

  // ---------------------------------------------------------------- QR login

  /** Starts a QR login. Show `loginUrl` as a QR code (or `qrImage`), then call `waitForScan`. */
  async startQrLogin(): Promise<{ loginUrl: string; qrImage: string; pollUrl: string; expiresAt: number }> {
    const q = new URLSearchParams({
      _qrsize: '240',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      callback: 'https://sts.api.io.mi.com/sts',
      _hasLogo: 'false',
      sid: 'xiaomiio',
      serviceParam: '',
      _locale: 'zh_CN',
      _dc: String(Date.now()),
    });
    const res = await this.#fetch(`${this.#accountBase}/longPolling/loginUrl?${q}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new CloudError(`Xiaomi account: HTTP ${res.status}`);
    const body = stripStart(await res.text());
    if (typeof body.loginUrl !== 'string' || typeof body.lp !== 'string') throw new CloudError(`Xiaomi account: unexpected reply (${String(body.desc ?? body.code ?? '?')})`);
    return { loginUrl: body.loginUrl, qrImage: String(body.qr ?? ''), pollUrl: body.lp, expiresAt: Date.now() + Number(body.timeout ?? 300) * 1000 };
  }

  /** Long-polls until the code is scanned and confirmed in the Mi Home app; resolves the session. */
  async waitForScan(pollUrl: string, country: string, signal?: AbortSignal): Promise<Session> {
    const res = await this.#fetch(pollUrl, { signal: signal ?? AbortSignal.timeout(330_000) });
    if (!res.ok) throw new CloudError(`QR login expired or was cancelled (HTTP ${res.status})`);
    const body = stripStart(await res.text());
    if (body.code !== 0 || typeof body.ssecurity !== 'string' || typeof body.location !== 'string') throw new CloudError(`QR login failed: ${String(body.desc ?? body.code)}`);
    const sts = await this.#fetch(body.location, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const cookies = sts.headers.getSetCookie?.() ?? [];
    const serviceToken = cookies.map((c) => /^serviceToken=([^;]+)/.exec(c)?.[1]).find(Boolean);
    if (!serviceToken) throw new CloudError('QR login: no service token returned');
    this.session = { userId: String(body.userId), ssecurity: body.ssecurity, serviceToken, country };
    return this.session;
  }

  // ---------------------------------------------------------------- API

  async call<T = unknown>(path: string, data: unknown): Promise<T> {
    const s = this.session;
    if (!s) throw new CloudError('Not signed in to a Xiaomi account');
    const { fields, signedNonce: sn } = encryptParams(s.ssecurity, path, { data: JSON.stringify(data) });
    const url = `${this.#apiBase ?? apiBase(s.country)}${path}`;
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'user-agent': AGENT,
        'content-type': 'application/x-www-form-urlencoded',
        'accept-encoding': 'identity',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'miot-encrypt-algorithm': 'ENCRYPT-RC4',
        cookie: [`userId=${s.userId}`, `yetAnotherServiceToken=${s.serviceToken}`, `serviceToken=${s.serviceToken}`, 'locale=zh_CN', 'timezone=GMT%2B08%3A00', 'channel=MI_APP_STORE'].join('; '),
      },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) throw new CloudError('The Xiaomi session expired; sign in again', res.status);
    if (!res.ok) throw new CloudError(`Mi Home cloud: HTTP ${res.status}`, res.status);
    const text = await res.text();
    let body: { code?: number; message?: string; result?: unknown };
    try {
      body = JSON.parse(rc4Decrypt(sn, text)) as typeof body;
    } catch {
      throw new CloudError('Mi Home cloud: could not decrypt the reply (session expired?)');
    }
    if (body.code !== 0) throw new CloudError(`Mi Home cloud: ${body.message ?? `code ${body.code}`}`, body.code);
    return body.result as T;
  }

  async devices(): Promise<CloudDevice[]> {
    const r = await this.call<{ list?: CloudDevice[] }>('/home/device_list', { getVirtualModel: true, getHuamiDevices: 1, get_split_device: false, support_smart_home: true });
    return (r.list ?? []).map((d) => ({ ...d, did: String(d.did) }));
  }

  async getProps(params: { did: string; siid: number; piid: number }[]): Promise<{ did: string; siid: number; piid: number; code: number; value?: unknown }[]> {
    return this.call('/miotspec/prop/get', { params });
  }

  async setProps(params: { did: string; siid: number; piid: number; value: unknown }[]): Promise<{ did: string; siid: number; piid: number; code: number }[]> {
    return this.call('/miotspec/prop/set', { params });
  }
}
