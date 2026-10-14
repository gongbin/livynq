import { H264, H265, h264Type, h265IsKey, h265Type } from './codecs.ts';

export interface RtpPacket {
  payloadType: number;
  marker: boolean;
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}

export function parseRtp(buf: Uint8Array): RtpPacket | undefined {
  if (buf.length < 12 || buf[0]! >> 6 !== 2) return undefined;
  const padding = (buf[0]! & 0x20) !== 0;
  const extension = (buf[0]! & 0x10) !== 0;
  const csrc = buf[0]! & 0x0f;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12 + csrc * 4;
  if (extension) {
    if (buf.length < offset + 4) return undefined;
    offset += 4 + view.getUint16(offset + 2) * 4;
  }
  let end = buf.length;
  if (padding) end -= buf[buf.length - 1]!;
  if (offset > end) return undefined;
  return {
    payloadType: buf[1]! & 0x7f,
    marker: (buf[1]! & 0x80) !== 0,
    sequence: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: buf.subarray(offset, end),
  };
}

/** One decodable picture: the NAL units sharing an RTP timestamp. */
export interface VideoFrame {
  nalus: Uint8Array[];
  /** RTP timestamp (90 kHz, wraps at 2^32) */
  timestamp: number;
  key: boolean;
}

export interface ParameterSets {
  vps?: Uint8Array;
  sps?: Uint8Array;
  pps?: Uint8Array;
}

/**
 * Reassembles NAL units from RTP (RFC 6184 / RFC 7798) and groups them into frames. Parameter
 * sets are kept aside (they go into the avcC / hvcC record) and stripped from the frames, as are
 * access unit delimiters.
 */
export class VideoDepacketizer {
  readonly codec: 'h264' | 'h265';
  readonly params: ParameterSets = {};
  #nalus: Uint8Array[] = [];
  #ts: number | undefined;
  #key = false;
  #fu: Uint8Array[] | undefined;
  #lastSeq: number | undefined;
  #broken = false;
  #waitKey = false;

  constructor(codec: 'h264' | 'h265', initial: ParameterSets = {}) {
    this.codec = codec;
    Object.assign(this.params, initial);
  }

  push(p: RtpPacket): VideoFrame[] {
    const out: VideoFrame[] = [];
    const lost = this.#lastSeq !== undefined && ((this.#lastSeq + 1) & 0xffff) !== p.sequence;
    this.#lastSeq = p.sequence;
    if (this.#ts !== undefined && p.timestamp !== this.#ts) this.#flush(out);
    if (lost) {
      // A lost packet makes the current frame unusable, and later frames until the next keyframe.
      this.#fu = undefined;
      this.#broken = true;
      this.#waitKey = true;
    }
    this.#ts = p.timestamp;
    if (this.codec === 'h264') this.#h264(p.payload);
    else this.#h265(p.payload);
    if (p.marker) this.#flush(out);
    return out;
  }

  #flush(out: VideoFrame[]): void {
    if (this.#key && !this.#broken) this.#waitKey = false;
    if (this.#nalus.length && !this.#broken && !this.#waitKey && this.#ts !== undefined) out.push({ nalus: this.#nalus, timestamp: this.#ts, key: this.#key });
    this.#nalus = [];
    this.#key = false;
    this.#broken = false;
    this.#fu = undefined;
  }

  #nal(nal: Uint8Array): void {
    if (!nal.length) return;
    if (this.codec === 'h264') {
      const t = h264Type(nal);
      if (t === H264.SPS) return void (this.params.sps = nal.slice());
      if (t === H264.PPS) return void (this.params.pps = nal.slice());
      if (t === H264.AUD) return;
      if (t === H264.IDR) this.#key = true;
    } else {
      const t = h265Type(nal);
      if (t === H265.VPS) return void (this.params.vps = nal.slice());
      if (t === H265.SPS) return void (this.params.sps = nal.slice());
      if (t === H265.PPS) return void (this.params.pps = nal.slice());
      if (t === H265.AUD) return;
      if (h265IsKey(t)) this.#key = true;
    }
    this.#nalus.push(nal);
  }

  #h264(pl: Uint8Array): void {
    if (!pl.length) return;
    const type = pl[0]! & 0x1f;
    if (type >= 1 && type <= 23) return this.#nal(pl.slice());
    if (type === H264.STAP_A) {
      for (let i = 1; i + 2 <= pl.length; ) {
        const size = (pl[i]! << 8) | pl[i + 1]!;
        this.#nal(pl.slice(i + 2, i + 2 + size));
        i += 2 + size;
      }
      return;
    }
    if (type === H264.FU_A) {
      if (pl.length < 2) return;
      const fu = pl[1]!;
      const start = (fu & 0x80) !== 0;
      const end = (fu & 0x40) !== 0;
      if (start) this.#fu = [Uint8Array.of((pl[0]! & 0xe0) | (fu & 0x1f))];
      if (!this.#fu) return;
      this.#fu.push(pl.subarray(2));
      if (end) {
        this.#nal(Buffer.concat(this.#fu));
        this.#fu = undefined;
      }
    }
    // STAP-B, MTAP, FU-B (interleaved mode) are not used by cameras.
  }

  #h265(pl: Uint8Array): void {
    if (pl.length < 2) return;
    const type = (pl[0]! >> 1) & 0x3f;
    if (type < 48) return this.#nal(pl.slice());
    if (type === H265.AP) {
      for (let i = 2; i + 2 <= pl.length; ) {
        const size = (pl[i]! << 8) | pl[i + 1]!;
        this.#nal(pl.slice(i + 2, i + 2 + size));
        i += 2 + size;
      }
      return;
    }
    if (type === H265.FU) {
      if (pl.length < 3) return;
      const fu = pl[2]!;
      const start = (fu & 0x80) !== 0;
      const end = (fu & 0x40) !== 0;
      const nalType = fu & 0x3f;
      if (start) this.#fu = [Uint8Array.of((pl[0]! & 0x81) | (nalType << 1), pl[1]!)];
      if (!this.#fu) return;
      this.#fu.push(pl.subarray(3));
      if (end) {
        this.#nal(Buffer.concat(this.#fu));
        this.#fu = undefined;
      }
    }
  }
}

/** RFC 3640 mpeg4-generic (AAC-hbr): AU headers of sizeLength + indexLength bits. */
export class AacDepacketizer {
  readonly #sizeLength: number;
  readonly #indexLength: number;

  constructor(sizeLength = 13, indexLength = 3) {
    this.#sizeLength = sizeLength;
    this.#indexLength = indexLength;
  }

  /** Returns the access units with their RTP timestamps (1024 samples each). */
  push(p: RtpPacket): { data: Uint8Array; timestamp: number }[] {
    const pl = p.payload;
    if (pl.length < 2) return [];
    const headerBits = (pl[0]! << 8) | pl[1]!;
    const headerBytes = Math.ceil(headerBits / 8);
    const perAu = this.#sizeLength + this.#indexLength;
    const count = Math.floor(headerBits / perAu);
    const out: { data: Uint8Array; timestamp: number }[] = [];
    let bit = 16;
    let offset = 2 + headerBytes;
    for (let i = 0; i < count; i++) {
      let size = 0;
      for (let b = 0; b < this.#sizeLength; b++, bit++) size = size * 2 + ((pl[bit >> 3]! >> (7 - (bit & 7))) & 1);
      bit += this.#indexLength;
      if (offset + size > pl.length) break;
      out.push({ data: pl.slice(offset, offset + size), timestamp: (p.timestamp + i * 1024) >>> 0 });
      offset += size;
    }
    return out;
  }
}

/** Packetizes NAL units for tests and the demo camera (single NAL or FU, ≤ mtu bytes). */
export function packetize(codec: 'h264' | 'h265', nalus: Uint8Array[], timestamp: number, seq: { n: number }, pt = 96, mtu = 1200): Buffer[] {
  const out: Buffer[] = [];
  nalus.forEach((nal, idx) => {
    const last = idx === nalus.length - 1;
    const header = (marker: boolean) => {
      const h = Buffer.alloc(12);
      h[0] = 0x80;
      h[1] = (marker ? 0x80 : 0) | pt;
      h.writeUInt16BE(seq.n++ & 0xffff, 2);
      h.writeUInt32BE(timestamp >>> 0, 4);
      h.writeUInt32BE(0x1234abcd, 8);
      return h;
    };
    if (nal.length <= mtu) return void out.push(Buffer.concat([header(last), nal]));
    const hdrLen = codec === 'h264' ? 1 : 2;
    const body = nal.subarray(hdrLen);
    for (let i = 0; i < body.length; i += mtu) {
      const start = i === 0;
      const end = i + mtu >= body.length;
      const chunk = body.subarray(i, i + mtu);
      const fuHeaders =
        codec === 'h264'
          ? [(nal[0]! & 0xe0) | H264.FU_A, (start ? 0x80 : 0) | (end ? 0x40 : 0) | (nal[0]! & 0x1f)]
          : [(nal[0]! & 0x81) | (H265.FU << 1), nal[1]!, (start ? 0x80 : 0) | (end ? 0x40 : 0) | ((nal[0]! >> 1) & 0x3f)];
      out.push(Buffer.concat([header(last && end), Buffer.from(fuHeaders), chunk]));
    }
  });
  return out;
}
