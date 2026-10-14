import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { digestResponse } from './auth.ts';
import { splitAnnexB } from './bits.ts';
import { H264, H265, h264Type, h265Type } from './codecs.ts';
import { packetize } from './rtp.ts';

/**
 * A tiny RTSP camera: loops an Annex-B clip over RTP interleaved on TCP, with optional Digest
 * auth. Used by tests and by the demo hub (`livynq start --demo`) so the camera UI has a stream.
 */

export interface FakeCameraOptions {
  codec: 'h264' | 'h265';
  annexB: Uint8Array;
  fps?: number;
  username?: string;
  password?: string;
  /** send parameter sets in-band before every keyframe (like most cameras) */
  inBandParams?: boolean;
}

interface Frame {
  nalus: Uint8Array[];
  key: boolean;
}

/** Groups an elementary stream into frames: parameter sets / SEI belong to the next picture. */
export function framesFromAnnexB(codec: 'h264' | 'h265', data: Uint8Array): { frames: Frame[]; params: Uint8Array[] } {
  const frames: Frame[] = [];
  const params: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  for (const nal of splitAnnexB(data)) {
    const t = codec === 'h264' ? h264Type(nal) : h265Type(nal);
    const isParam = codec === 'h264' ? t === H264.SPS || t === H264.PPS : t === H265.VPS || t === H265.SPS || t === H265.PPS;
    if (isParam && params.length < (codec === 'h264' ? 2 : 3)) params.push(nal);
    const isPicture = codec === 'h264' ? t >= 1 && t <= 5 : t < 32;
    pending.push(nal);
    if (isPicture) {
      frames.push({ nalus: pending, key: codec === 'h264' ? t === H264.IDR : t >= 16 && t <= 23 });
      pending = [];
    }
  }
  return { frames, params };
}

export class FakeCamera {
  readonly #opts: Required<Omit<FakeCameraOptions, 'username' | 'password'>> & FakeCameraOptions;
  readonly #server: Server;
  readonly #frames: Frame[];
  readonly #params: Uint8Array[];
  readonly #realm = 'Livynq Fake Camera';
  readonly #nonce = randomBytes(8).toString('hex');
  /** RTSP methods received, in order (tests) */
  readonly requests: string[] = [];
  connections = 0;
  #sockets = new Set<Socket>();

  constructor(opts: FakeCameraOptions) {
    this.#opts = { fps: 15, inBandParams: true, ...opts };
    const { frames, params } = framesFromAnnexB(opts.codec, opts.annexB);
    this.#frames = frames;
    this.#params = params;
    this.#server = createServer((socket) => this.#serve(socket));
  }

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => this.#server.listen(port, host, () => resolve((this.#server.address() as { port: number }).port)));
  }

  close(): void {
    for (const s of this.#sockets) s.destroy();
    this.#server.close();
  }

  /** Drops every client connection (simulates a camera reboot). */
  dropClients(): void {
    for (const s of this.#sockets) s.destroy();
  }

  #sdp(): string {
    const b64 = (n: Uint8Array) => Buffer.from(n).toString('base64');
    const [a, b, c] = this.#params;
    const fmtp =
      this.#opts.codec === 'h264'
        ? `a=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=${Buffer.from(a!.subarray(1, 4)).toString('hex')};sprop-parameter-sets=${b64(a!)},${b64(b!)}`
        : `a=rtpmap:96 H265/90000\r\na=fmtp:96 sprop-vps=${b64(a!)};sprop-sps=${b64(b!)};sprop-pps=${b64(c!)}`;
    return ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Livynq', 't=0 0', 'a=control:*', 'm=video 0 RTP/AVP 96', fmtp, 'a=control:trackID=1', ''].join('\r\n');
  }

  #serve(socket: Socket): void {
    this.connections++;
    this.#sockets.add(socket);
    let buf = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    const seq = { n: Math.floor(Math.random() * 60000) };
    let ts = Math.floor(Math.random() * 2 ** 31);
    let i = 0;
    socket.on('close', () => {
      clearInterval(timer);
      this.#sockets.delete(socket);
    });
    socket.on('error', () => {});
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        const lines = head.split('\r\n');
        const [method, uri] = lines[0]!.split(' ');
        const header = (name: string) => lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
        const cseq = header('CSeq') ?? '0';
        this.requests.push(method!);
        const reply = (status: string, extra: string[] = [], body = '') =>
          socket.write([`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, ...extra, ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []), '', body].join('\r\n'));
        if (method === 'OPTIONS') {
          reply('200 OK', ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER']);
          continue;
        }
        if (this.#opts.username !== undefined && method !== 'TEARDOWN') {
          const auth = header('Authorization') ?? '';
          const resp = /response="([^"]+)"/.exec(auth)?.[1];
          const authUri = /uri="([^"]+)"/.exec(auth)?.[1] ?? uri!;
          if (resp !== digestResponse(this.#opts.username, this.#realm, this.#opts.password ?? '', method!, authUri, this.#nonce)) {
            reply('401 Unauthorized', [`WWW-Authenticate: Digest realm="${this.#realm}", nonce="${this.#nonce}"`]);
            continue;
          }
        }
        if (method === 'DESCRIBE') reply('200 OK', ['Content-Type: application/sdp', `Content-Base: ${uri}/`], this.#sdp());
        else if (method === 'SETUP') reply('200 OK', [`Transport: ${header('Transport')}`, 'Session: 12345678;timeout=60']);
        else if (method === 'GET_PARAMETER') reply('200 OK', ['Session: 12345678']);
        else if (method === 'PLAY') {
          reply('200 OK', ['Session: 12345678', 'Range: npt=0.000-']);
          clearInterval(timer);
          timer = setInterval(() => {
            const frame = this.#frames[i++ % this.#frames.length]!;
            const nalus = frame.key && this.#opts.inBandParams ? frame.nalus : frame.nalus.filter((n) => !this.#params.includes(n));
            for (const pkt of packetize(this.#opts.codec, nalus, ts, seq)) {
              const head4 = Buffer.from([0x24, 0, (pkt.length >> 8) & 0xff, pkt.length & 0xff]);
              socket.write(Buffer.concat([head4, pkt]));
            }
            ts = (ts + Math.round(90000 / this.#opts.fps)) >>> 0;
          }, 1000 / this.#opts.fps);
        } else if (method === 'TEARDOWN') {
          clearInterval(timer);
          reply('200 OK');
          socket.end();
        } else reply('501 Not Implemented');
      }
    });
  }
}
