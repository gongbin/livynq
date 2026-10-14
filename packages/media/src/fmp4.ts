import type { AudioConfig, VideoConfig } from './codecs.ts';

/**
 * Fragmented MP4 (ISO BMFF) for Media Source Extensions: an init segment (ftyp + moov) describing
 * the tracks, then one moof + mdat per frame. Video uses a 90 kHz timescale (RTP's), audio its
 * sample rate.
 */

const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u64 = (v: number) => [...u32(Math.floor(v / 2 ** 32)), ...u32(v >>> 0)];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

function box(type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  out.set([...u32(size), ...str(type)], 0);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const full = (type: string, version: number, flags: number, ...parts: (number[] | Uint8Array)[]) => box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

export const VIDEO_TRACK = 1;
export const AUDIO_TRACK = 2;
export const VIDEO_TIMESCALE = 90000;

function trak(id: number, handler: 'vide' | 'soun', timescale: number, sampleEntry: Uint8Array, width = 0, height = 0): Uint8Array {
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u16(handler === 'soun' ? 0x0100 : 0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), str(handler), u32(0), u32(0), u32(0), str(handler === 'vide' ? 'Livynq Video\0' : 'Livynq Audio\0'));
  const mediaHeader = handler === 'vide' ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const stbl = box('stbl', full('stsd', 0, 0, u32(1), sampleEntry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, stbl)));
}

function videoEntry(v: VideoConfig): Uint8Array {
  const compressor = new Array(32).fill(0);
  return box(
    v.codec === 'h264' ? 'avc1' : 'hvc1',
    new Array(6).fill(0),
    u16(1),
    new Array(16).fill(0),
    u16(v.width),
    u16(v.height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    compressor,
    u16(0x18),
    u16(0xffff),
    box(v.codec === 'h264' ? 'avcC' : 'hvcC', v.record),
  );
}

/** MPEG-4 descriptor with its size in the 4-byte expandable form. */
const descriptor = (tag: number, body: number[]) => [tag, 0x80 | ((body.length >> 21) & 0x7f), 0x80 | ((body.length >> 14) & 0x7f), 0x80 | ((body.length >> 7) & 0x7f), body.length & 0x7f, ...body];

function audioEntry(a: AudioConfig): Uint8Array {
  const dsi = descriptor(0x05, [...a.asc]);
  const decoderConfig = descriptor(0x04, [0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...dsi]);
  const es = descriptor(0x03, [...u16(AUDIO_TRACK), 0, ...decoderConfig, ...descriptor(0x06, [0x02])]);
  return box('mp4a', new Array(6).fill(0), u16(1), new Array(8).fill(0), u16(a.channels), u16(16), u16(0), u16(0), u32(a.sampleRate << 16), full('esds', 0, 0, es));
}

export function initSegment(video: VideoConfig, audio?: AudioConfig): Uint8Array {
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('mp41'), str(video.codec === 'h264' ? 'avc1' : 'hvc1'));
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(audio ? 3 : 2));
  const traks = [trak(VIDEO_TRACK, 'vide', VIDEO_TIMESCALE, videoEntry(video), video.width, video.height)];
  const trexes = [full('trex', 0, 0, u32(VIDEO_TRACK), u32(1), u32(0), u32(0), u32(0))];
  if (audio) {
    traks.push(trak(AUDIO_TRACK, 'soun', audio.sampleRate, audioEntry(audio)));
    trexes.push(full('trex', 0, 0, u32(AUDIO_TRACK), u32(1), u32(0), u32(0), u32(0)));
  }
  const moov = box('moov', mvhd, ...traks, box('mvex', ...trexes));
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}

export interface Sample {
  data: Uint8Array;
  duration: number;
  key: boolean;
}

/** moof + mdat for one track's consecutive samples starting at `decodeTime`. */
export function fragment(track: number, sequence: number, decodeTime: number, samples: Sample[]): Uint8Array {
  const entries = samples.flatMap((s) => [...u32(s.duration), ...u32(s.data.length), ...u32(s.key ? 0x02000000 : 0x01010000)]);
  const build = (dataOffset: number) =>
    box(
      'moof',
      full('mfhd', 0, 0, u32(sequence)),
      box('traf', full('tfhd', 0, 0x020000, u32(track)), full('tfdt', 1, 0, u64(decodeTime)), full('trun', 0, 0x000701, u32(samples.length), u32(dataOffset), entries)),
    );
  const moofSize = build(0).length;
  const moof = build(moofSize + 8);
  const mdatSize = 8 + samples.reduce((n, s) => n + s.data.length, 0);
  const out = new Uint8Array(moof.length + mdatSize);
  out.set(moof, 0);
  out.set([...u32(mdatSize), ...str('mdat')], moof.length);
  let o = moof.length + 8;
  for (const s of samples) {
    out.set(s.data, o);
    o += s.data.length;
  }
  return out;
}

/** NAL units → one length-prefixed (4 bytes) sample, the form avcC / hvcC tracks expect. */
export function lengthPrefixed(nalus: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nalus.reduce((n, x) => n + 4 + x.length, 0));
  let o = 0;
  for (const n of nalus) {
    out.set(u32(n.length), o);
    out.set(n, o + 4);
    o += 4 + n.length;
  }
  return out;
}

/** Minimal box walker (tests, diagnostics). */
export function boxes(data: Uint8Array, offset = 0, end = data.length): { type: string; start: number; size: number; body: Uint8Array }[] {
  const out: { type: string; start: number; size: number; body: Uint8Array }[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > end) break;
    out.push({ type, start: offset, size, body: data.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return out;
}

