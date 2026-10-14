import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';

/**
 * miIO, the LAN protocol of Xiaomi / Mijia Wi-Fi devices: UDP port 54321, JSON-RPC payloads
 * encrypted with AES-128-CBC derived from the device's 16-byte token.
 *
 *   header (32 bytes): 0x2131 | length u16 | 0 u32 | device id u32 | stamp u32 | checksum (16)
 *   key = md5(token), iv = md5(key ‖ token), checksum = md5(header[0..16] ‖ token ‖ ciphertext)
 *
 * A "hello" (all 0xff after the length) returns the device id and its uptime stamp, which every
 * later packet must continue.
 */

const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();
export const PORT = 54321;

export function keys(token: Buffer): { key: Buffer; iv: Buffer } {
  const key = md5(token);
  return { key, iv: md5(key, token) };
}

export function encrypt(token: Buffer, plain: Buffer): Buffer {
  const { key, iv } = keys(token);
  const c = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(plain), c.final()]);
}

export function decrypt(token: Buffer, data: Buffer): Buffer {
  const { key, iv } = keys(token);
  const d = createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

export const HELLO = Buffer.from('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');

export function encodePacket(token: Buffer, deviceId: number, stamp: number, payload: Buffer): Buffer {
  const data = encrypt(token, payload);
  const header = Buffer.alloc(32);
  header.writeUInt16BE(0x2131, 0);
  header.writeUInt16BE(32 + data.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(deviceId >>> 0, 8);
  header.writeUInt32BE(stamp >>> 0, 12);
  md5(header.subarray(0, 16), token, data).copy(header, 16);
  return Buffer.concat([header, data]);
}

export interface Decoded {
  deviceId: number;
  stamp: number;
  /** Decrypted payload; undefined for a hello reply */
  payload?: Buffer;
}

export function decodePacket(token: Buffer | undefined, msg: Buffer): Decoded {
  if (msg.length < 32 || msg.readUInt16BE(0) !== 0x2131) throw new Error('not a miIO packet');
  const length = msg.readUInt16BE(2);
  const deviceId = msg.readUInt32BE(8);
  const stamp = msg.readUInt32BE(12);
  if (length === 32 || !token) return { deviceId, stamp };
  const data = msg.subarray(32, length);
  const expected = md5(msg.subarray(0, 16), token, data);
  if (!expected.equals(msg.subarray(16, 32))) throw new Error('checksum mismatch (wrong token?)');
  return { deviceId, stamp, payload: decrypt(token, data) };
}

export class MiioError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** One device. Calls are serialized (devices drop concurrent requests); retries once on timeout. */
export class MiioDevice {
  readonly host: string;
  readonly port: number;
  #token: Buffer;
  #socket: Socket | undefined;
  #deviceId = 0;
  #stampBase = 0;
  #stampAt = 0;
  #id = Math.floor(Math.random() * 1000) + 1;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #hello: ((d: Decoded) => void) | undefined;
  readonly timeoutMs: number;

  constructor(options: { host: string; token: string; port?: number; timeoutMs?: number }) {
    if (!/^[0-9a-f]{32}$/i.test(options.token)) throw new Error('token must be 32 hex characters');
    // "192.168.1.40" or "host:port" (tests, port forwards)
    const m = /^(.+):(\d+)$/.exec(options.host);
    this.host = m ? m[1]! : options.host;
    this.port = options.port ?? (m ? Number(m[2]) : PORT);
    this.#token = Buffer.from(options.token, 'hex');
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  get deviceId(): number {
    return this.#deviceId;
  }

  #open(): Socket {
    if (this.#socket) return this.#socket;
    const socket = createSocket('udp4');
    socket.on('message', (msg) => {
      let d: Decoded;
      try {
        d = decodePacket(this.#token, msg);
      } catch {
        return;
      }
      if (!d.payload) return this.#hello?.(d);
      let body: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
      try {
        // Some firmwares end the JSON with NUL bytes or send invalid trailing commas.
        body = JSON.parse(d.payload.toString('utf8').replace(/\0+$/, '').replace(/,\s*}/g, '}'));
      } catch {
        return;
      }
      const p = typeof body.id === 'number' ? this.#pending.get(body.id) : undefined;
      if (!p) return;
      this.#pending.delete(body.id!);
      if (body.error) p.reject(new MiioError(body.error.message ?? 'device error', body.error.code));
      else p.resolve(body.result);
    });
    socket.on('error', () => {});
    socket.unref();
    this.#socket = socket;
    return socket;
  }

  async #handshake(): Promise<void> {
    const socket = this.#open();
    const d = await new Promise<Decoded>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#hello = undefined;
        reject(new MiioError(`${this.host} did not answer (is it on this network?)`));
      }, this.timeoutMs);
      this.#hello = (r) => {
        clearTimeout(timer);
        this.#hello = undefined;
        resolve(r);
      };
      socket.send(HELLO, this.port, this.host);
    });
    this.#deviceId = d.deviceId;
    this.#stampBase = d.stamp;
    this.#stampAt = Date.now();
  }

  #stamp(): number {
    return this.#stampBase + Math.floor((Date.now() - this.#stampAt) / 1000);
  }

  call<T = unknown>(method: string, params: unknown = []): Promise<T> {
    const run = this.#queue.then(() => this.#send<T>(method, params, true));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #send<T>(method: string, params: unknown, retry: boolean): Promise<T> {
    // Handshake again after a while: devices reset their stamp when they reboot.
    if (!this.#deviceId || Date.now() - this.#stampAt > 60_000) await this.#handshake();
    const id = (this.#id = (this.#id % 9999) + 1);
    const packet = encodePacket(this.#token, this.#deviceId, this.#stamp() + 1, Buffer.from(JSON.stringify({ id, method, params })));
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new MiioError(`${this.host}: ${method} timed out`));
        }, this.timeoutMs);
        this.#pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v as T)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        this.#open().send(packet, this.port, this.host);
      });
    } catch (err) {
      if (!retry || (err instanceof MiioError && err.code !== undefined)) throw err;
      this.#deviceId = 0;
      return this.#send<T>(method, params, false);
    }
  }

  close(): void {
    for (const p of this.#pending.values()) p.reject(new MiioError('closed'));
    this.#pending.clear();
    this.#socket?.close();
    this.#socket = undefined;
  }
}

/** Broadcast hello: devices on the LAN answer with their id (tokens are not revealed). */
export function discover(timeoutMs = 2000, address = '255.255.255.255'): Promise<{ host: string; deviceId: number }[]> {
  return new Promise((resolve) => {
    const found = new Map<string, number>();
    const socket = createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      try {
        found.set(rinfo.address, decodePacket(undefined, msg).deviceId);
      } catch {
        // not miIO
      }
    });
    socket.on('error', () => {});
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(HELLO, PORT, address);
    });
    setTimeout(() => {
      socket.close();
      resolve([...found].map(([host, deviceId]) => ({ host, deviceId })));
    }, timeoutMs);
  });
}
