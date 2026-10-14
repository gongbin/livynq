/** The parts of an SDP description an RTSP client needs. */

export interface SdpMedia {
  type: string;
  payloadType: number;
  /** "H264", "H265", "MPEG4-GENERIC", "PCMA"… (upper case) */
  encoding: string;
  clockRate: number;
  channels?: number;
  fmtp: Record<string, string>;
  control?: string;
}

export interface Sdp {
  control?: string;
  media: SdpMedia[];
}

export function parseSdp(text: string): Sdp {
  const sdp: Sdp = { media: [] };
  let current: SdpMedia | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      const [type, , , pt] = line.slice(2).split(/\s+/);
      current = { type: type ?? '', payloadType: Number(pt), encoding: '', clockRate: 0, fmtp: {} };
      sdp.media.push(current);
      continue;
    }
    if (!line.startsWith('a=')) continue;
    const attr = line.slice(2);
    const colon = attr.indexOf(':');
    const name = colon < 0 ? attr : attr.slice(0, colon);
    const value = colon < 0 ? '' : attr.slice(colon + 1);
    if (name === 'control') {
      if (current) current.control = value.trim();
      else sdp.control = value.trim();
    } else if (current && name === 'rtpmap') {
      const m = /^(\d+)\s+([^/]+)\/(\d+)(?:\/(\d+))?/.exec(value);
      if (m && Number(m[1]) === current.payloadType) {
        current.encoding = m[2]!.toUpperCase();
        current.clockRate = Number(m[3]);
        if (m[4]) current.channels = Number(m[4]);
      }
    } else if (current && name === 'fmtp') {
      const sp = value.indexOf(' ');
      for (const kv of value.slice(sp + 1).split(';')) {
        const eq = kv.indexOf('=');
        if (eq > 0) current.fmtp[kv.slice(0, eq).trim().toLowerCase()] = kv.slice(eq + 1).trim();
      }
    }
  }
  return sdp;
}

/** Resolves a control attribute against the base URL (Content-Base or the request URL). */
export function controlUrl(base: string, control: string | undefined): string {
  if (!control || control === '*') return base;
  if (/^rtsps?:\/\//i.test(control)) return control;
  return base.endsWith('/') ? base + control : `${base}/${control}`;
}
