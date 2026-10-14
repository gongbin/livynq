import { EventEmitter } from 'node:events';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Authenticator } from './auth.ts';
import { aacConfig, h264Config, h265Config, type AudioConfig, type VideoConfig } from './codecs.ts';
import { AacDepacketizer, VideoDepacketizer, parseRtp, type ParameterSets, type VideoFrame } from './rtp.ts';
import { controlUrl, parseSdp, type SdpMedia } from './sdp.ts';

/**
 * RTSP client (RFC 2326) that plays one camera stream with RTP interleaved over the TCP
 * connection — no UDP ports, works through NAT and Docker. Picks the first H.264 / H.265 video
 * track and, when present, an AAC (mpeg4-generic) audio track.
 *
 * Events: 'video' (VideoFrame), 'audio' ({ data, timestamp }), 'config' (VideoConfig, when
 * parameter sets become known or change), 'close' (Error | undefined).
 */

export class RtspError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

interface Response {
  status: number;
  reason: string;
  headers: Map<string, string[]>;
  body: Buffer;
}

export interface RtspOptions {
  url: string;
  username?: string;
  password?: string;
  /** per request and for the first media data */
  timeoutMs?: number;
  /** close when no media arrives for this long */
  idleTimeoutMs?: number;
  userAgent?: string;
}

const redact = (url: string) => url.replace(/\/\/[^@/]*@/, '//');

export class RtspSession extends EventEmitter {
  readonly #opts: Required<Omit<RtspOptions, 'username' | 'password'>>;
  readonly #auth: Authenticator;
  #url: string;
  #socket: Socket | undefined;
  #buf: Buffer = Buffer.alloc(0);
  #cseq = 0;
  #pending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #session: string | undefined;
  #keepalive: NodeJS.Timeout | undefined;
  #idle: NodeJS.Timeout | undefined;
  #closed = false;
  #channels = new Map<number, (payload: Uint8Array) => void>();
  #supportsGetParameter = false;

  video: { codec: 'h264' | 'h265'; config?: VideoConfig } | undefined;
  audio: AudioConfig | undefined;

  constructor(opts: RtspOptions) {
    super();
    this.#url = opts.url;
    this.#auth = new Authenticator(opts.username, opts.password);
    this.#opts = { url: opts.url, timeoutMs: opts.timeoutMs ?? 8000, idleTimeoutMs: opts.idleTimeoutMs ?? 15000, userAgent: opts.userAgent ?? 'Livynq' };
  }

  get url(): string {
    return redact(this.#url);
  }

  async start(): Promise<void> {
    for (let redirects = 0; ; redirects++) {
      await this.#connect();
      const options = await this.#request('OPTIONS', this.#url);
      this.#supportsGetParameter = (options.headers.get('public')?.[0] ?? '').toUpperCase().includes('GET_PARAMETER');
      const describe = await this.#request('DESCRIBE', this.#url, { Accept: 'application/sdp' }, true);
      if ((describe.status === 301 || describe.status === 302) && redirects < 3) {
        const location = describe.headers.get('location')?.[0];
        if (!location) throw new RtspError('redirect without Location');
        this.#url = location;
        this.#socket?.removeAllListeners();
        this.#socket?.destroy();
        this.#session = undefined;
        continue;
      }
      this.#check(describe, 'DESCRIBE');
      await this.#setup(describe);
      return;
    }
  }

  async #setup(describe: Response): Promise<void> {
    const base = describe.headers.get('content-base')?.[0] ?? describe.headers.get('content-location')?.[0] ?? this.#url;
    const sdp = parseSdp(describe.body.toString('utf8'));
    const sessionBase = controlUrl(base.replace(/\/$/, ''), sdp.control);
    const video = sdp.media.find((m) => m.type === 'video' && (m.encoding === 'H264' || m.encoding === 'H265' || m.encoding === 'HEVC'));
    if (!video) {
      const found = sdp.media.map((m) => `${m.type}/${m.encoding || m.payloadType}`).join(', ');
      throw new RtspError(`no H.264 / H.265 video in the stream (${found || 'empty SDP'})`);
    }
    const audio = sdp.media.find((m) => m.type === 'audio' && m.encoding === 'MPEG4-GENERIC' && m.fmtp.config && /aac-hbr/i.test(m.fmtp.mode ?? ''));

    let channel = 0;
    const setup = async (m: SdpMedia) => {
      const ch = channel;
      channel += 2;
      const res = await this.#request('SETUP', controlUrl(sessionBase, m.control), { Transport: `RTP/AVP/TCP;unicast;interleaved=${ch}-${ch + 1}` });
      this.#check(res, 'SETUP');
      const session = res.headers.get('session')?.[0];
      if (session) {
        const [id, ...rest] = session.split(';');
        this.#session = id!.trim();
        const timeout = rest.map((p) => /timeout\s*=\s*(\d+)/i.exec(p)?.[1]).find(Boolean);
        this.#startKeepalive(timeout ? Number(timeout) : 60);
      }
      const transport = res.headers.get('transport')?.[0] ?? '';
      const interleaved = /interleaved=(\d+)/i.exec(transport);
      return interleaved ? Number(interleaved[1]) : ch;
    };

    const codec = video.encoding === 'H264' ? 'h264' : 'h265';
    this.video = { codec };
    const params: ParameterSets = {};
    if (codec === 'h264' && video.fmtp['sprop-parameter-sets']) {
      const [sps, pps] = video.fmtp['sprop-parameter-sets'].split(',').map((s) => Uint8Array.from(Buffer.from(s, 'base64')));
      if (sps?.length) params.sps = sps;
      if (pps?.length) params.pps = pps;
    }
    if (codec === 'h265') {
      for (const [k, key] of [['sprop-vps', 'vps'], ['sprop-sps', 'sps'], ['sprop-pps', 'pps']] as const) {
        const v = video.fmtp[k];
        if (v) params[key] = Uint8Array.from(Buffer.from(v.split(',')[0]!, 'base64'));
      }
    }
    const depacketizer = new VideoDepacketizer(codec, params);
    this.#updateConfig(depacketizer.params);
    const videoChannel = await setup(video);
    this.#channels.set(videoChannel, (buf) => {
      const p = parseRtp(buf);
      if (!p || p.payloadType !== video.payloadType) return;
      for (const frame of depacketizer.push(p)) {
        if (frame.key) this.#updateConfig(depacketizer.params);
        if (!this.video?.config) continue; // nothing decodable until parameter sets are known
        this.emit('video', frame satisfies VideoFrame);
      }
    });

    if (audio) {
      try {
        const cfg = aacConfig(audio.fmtp.config!);
        const aacDepacketizer = new AacDepacketizer(Number(audio.fmtp.sizelength ?? 13), Number(audio.fmtp.indexlength ?? 3));
        const audioChannel = await setup(audio);
        this.audio = cfg;
        this.#channels.set(audioChannel, (buf) => {
          const p = parseRtp(buf);
          if (!p || p.payloadType !== audio.payloadType) return;
          for (const au of aacDepacketizer.push(p)) this.emit('audio', au);
        });
      } catch {
        this.audio = undefined; // video without sound beats no video
      }
    }

    this.#check(await this.#request('PLAY', sessionBase, { Range: 'npt=0.000-' }), 'PLAY');
    this.#touch();
  }

  #updateConfig(p: ParameterSets): void {
    if (!this.video) return;
    let config: VideoConfig | undefined;
    try {
      if (this.video.codec === 'h264' && p.sps && p.pps) config = h264Config(p.sps, p.pps);
      if (this.video.codec === 'h265' && p.vps && p.sps && p.pps) config = h265Config(p.vps, p.sps, p.pps);
    } catch {
      return; // malformed SPS: wait for the next one
    }
    if (config && config.key !== this.video.config?.key) {
      this.video.config = config;
      this.emit('config', config);
    }
  }

  #check(res: Response, what: string): void {
    if (res.status === 401) throw new RtspError(this.#auth.hasCredentials ? 'the camera rejected the username or password' : 'the camera needs a username and password', 401);
    if (res.status >= 300) throw new RtspError(`${what} failed: ${res.status} ${res.reason}`, res.status);
  }

  #startKeepalive(timeoutSeconds: number): void {
    clearInterval(this.#keepalive);
    const every = Math.max(5, Math.min(timeoutSeconds, 120) * 0.5) * 1000;
    this.#keepalive = setInterval(() => {
      void this.#request(this.#supportsGetParameter ? 'GET_PARAMETER' : 'OPTIONS', this.#url).catch(() => {});
    }, every);
    this.#keepalive.unref();
  }

  #touch(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.#fail(new RtspError(`no video from the camera for ${Math.round(this.#opts.idleTimeoutMs / 1000)} s`)), this.#opts.idleTimeoutMs);
    this.#idle.unref();
  }

  #connect(): Promise<void> {
    const u = new URL(this.#url);
    const secure = u.protocol === 'rtsps:';
    const port = Number(u.port || (secure ? 322 : 554));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RtspError(`${u.hostname}:${port} did not answer`));
      }, this.#opts.timeoutMs);
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      // Cameras use self-signed certificates; the stream is authenticated by Digest.
      const socket: Socket = secure ? tlsConnect({ host: u.hostname, port, rejectUnauthorized: false, servername: u.hostname }, onConnect) : netConnect({ host: u.hostname, port }, onConnect);
      socket.setNoDelay(true);
      socket.on('data', (d: Buffer) => this.#onData(d));
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
        this.#fail(err);
      });
      socket.on('close', () => this.#fail(new RtspError('connection closed by the camera')));
      this.#socket = socket;
      this.#buf = Buffer.alloc(0);
    });
  }

  #request(method: string, url: string, headers: Record<string, string> = {}, allowRedirect = false): Promise<Response> {
    const send = (): Promise<Response> => {
      const cseq = ++this.#cseq;
      const plainUrl = redact(url);
      const lines = [`${method} ${plainUrl} RTSP/1.0`, `CSeq: ${cseq}`, `User-Agent: ${this.#opts.userAgent}`];
      const auth = this.#auth.header(method, plainUrl);
      if (auth) lines.push(`Authorization: ${auth}`);
      if (this.#session) lines.push(`Session: ${this.#session}`);
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(cseq);
          reject(new RtspError(`${method} timed out`));
        }, this.#opts.timeoutMs);
        this.#pending.set(cseq, { resolve, reject, timer });
        this.#socket?.write(`${lines.join('\r\n')}\r\n\r\n`);
      });
    };
    return send().then((res) => {
      if (res.status === 401 && this.#auth.accept(res.headers.get('www-authenticate') ?? [])) return send();
      if (!allowRedirect && (res.status === 301 || res.status === 302)) throw new RtspError(`${method}: unexpected redirect`, res.status);
      return res;
    });
  }

  #onData(chunk: Buffer): void {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    for (;;) {
      if (!this.#buf.length) return;
      if (this.#buf[0] === 0x24) {
        if (this.#buf.length < 4) return;
        const len = this.#buf.readUInt16BE(2);
        if (this.#buf.length < 4 + len) return;
        const channel = this.#buf[1]!;
        const payload = this.#buf.subarray(4, 4 + len);
        this.#buf = this.#buf.subarray(4 + len);
        const handler = this.#channels.get(channel);
        if (handler) {
          this.#touch();
          try {
            handler(payload);
          } catch (err) {
            this.emit('warning', err);
          }
        }
        continue;
      }
      const end = this.#buf.indexOf('\r\n\r\n');
      if (end < 0) {
        // Junk before a response (some cameras pad): resync on the next '$' or 'RTSP/'.
        if (this.#buf.length > 64 * 1024) this.#buf = Buffer.alloc(0);
        return;
      }
      const head = this.#buf.subarray(0, end).toString('utf8');
      if (!head.startsWith('RTSP/')) {
        const next = [this.#buf.indexOf(0x24, 1), this.#buf.indexOf('RTSP/', 1)].filter((i) => i > 0);
        this.#buf = next.length ? this.#buf.subarray(Math.min(...next)) : Buffer.alloc(0);
        continue;
      }
      const lines = head.split('\r\n');
      const status = /^RTSP\/\d\.\d\s+(\d+)\s*(.*)$/.exec(lines[0]!);
      const headers = new Map<string, string[]>();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        headers.set(k, [...(headers.get(k) ?? []), line.slice(i + 1).trim()]);
      }
      const length = Number(headers.get('content-length')?.[0] ?? 0);
      if (this.#buf.length < end + 4 + length) return;
      const body = this.#buf.subarray(end + 4, end + 4 + length);
      this.#buf = this.#buf.subarray(end + 4 + length);
      const cseq = Number(headers.get('cseq')?.[0]);
      const p = this.#pending.get(cseq);
      if (p) {
        this.#pending.delete(cseq);
        clearTimeout(p.timer);
        p.resolve({ status: Number(status?.[1] ?? 0), reason: status?.[2] ?? '', headers, body: Buffer.from(body) });
      }
    }
  }

  #fail(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#keepalive);
    clearTimeout(this.#idle);
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    this.#socket?.destroy();
    this.emit('close', err);
  }

  close(): void {
    if (this.#closed) return;
    if (this.#session && this.#socket?.writable) {
      const lines = [`TEARDOWN ${redact(this.#url)} RTSP/1.0`, `CSeq: ${++this.#cseq}`, `Session: ${this.#session}`];
      const auth = this.#auth.header('TEARDOWN', redact(this.#url));
      if (auth) lines.push(`Authorization: ${auth}`);
      this.#socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    }
    this.#closed = true;
    clearInterval(this.#keepalive);
    clearTimeout(this.#idle);
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RtspError('closed'));
    }
    this.#pending.clear();
    this.#socket?.end();
    setTimeout(() => this.#socket?.destroy(), 500).unref();
    this.emit('close', undefined);
  }
}
