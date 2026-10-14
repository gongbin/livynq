import { BitReader, hex, unescapeRbsp } from './bits.ts';

/** What the muxer needs to describe a video track. */
export interface VideoConfig {
  codec: 'h264' | 'h265';
  /** RFC 6381 codec string for MediaSource ("avc1.4D401F", "hvc1.1.6.L93.B0") */
  mime: string;
  width: number;
  height: number;
  /** avcC / hvcC box payload */
  record: Uint8Array;
  /** Parameter sets, for identity comparison (resolution changes need a new init segment) */
  key: string;
}

// ---------------------------------------------------------------- H.264

export const H264 = { SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9, STAP_A: 24, FU_A: 28 } as const;
export const h264Type = (nal: Uint8Array) => nal[0]! & 0x1f;

export interface H264Sps {
  profile: number;
  constraints: number;
  level: number;
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  width: number;
  height: number;
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

export function parseH264Sps(nal: Uint8Array): H264Sps {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profile = r.bits(8);
  const constraints = r.bits(8);
  const level = r.bits(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormat = 1;
  let bitDepthLuma = 8;
  let bitDepthChroma = 8;
  if (HIGH_PROFILES.has(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) r.skip(1);
    bitDepthLuma = r.ue() + 8;
    bitDepthChroma = r.ue() + 8;
    r.skip(1); // qpprime_y_zero_transform_bypass
    if (r.bit()) for (let i = 0; i < (chromaFormat === 3 ? 12 : 8); i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.skip(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.skip(1); // gaps_in_frame_num_value_allowed
  const wMbs = r.ue() + 1;
  const hMap = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.skip(1);
  r.skip(1); // direct_8x8_inference
  let [cl, cr, ct, cb] = [0, 0, 0, 0];
  if (r.bit()) [cl, cr, ct, cb] = [r.ue(), r.ue(), r.ue(), r.ue()];
  const cropX = chromaFormat === 0 || chromaFormat === 3 ? 1 : 2;
  const cropY = (chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    profile,
    constraints,
    level,
    chromaFormat,
    bitDepthLuma,
    bitDepthChroma,
    width: wMbs * 16 - cropX * (cl + cr),
    height: (2 - frameMbsOnly) * hMap * 16 - cropY * (ct + cb),
  };
}

export function h264Config(sps: Uint8Array, pps: Uint8Array): VideoConfig {
  const s = parseH264Sps(sps);
  const head = [1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1];
  const parts: number[] = [...head, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps];
  if (HIGH_PROFILES.has(s.profile)) parts.push(0xfc | s.chromaFormat, 0xf8 | (s.bitDepthLuma - 8), 0xf8 | (s.bitDepthChroma - 8), 0);
  return {
    codec: 'h264',
    mime: `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`,
    width: s.width,
    height: s.height,
    record: Uint8Array.from(parts),
    key: Buffer.concat([sps, pps]).toString('base64'),
  };
}

// ---------------------------------------------------------------- H.265

export const H265 = { VPS: 32, SPS: 33, PPS: 34, AUD: 35, SEI_PREFIX: 39, AP: 48, FU: 49 } as const;
export const h265Type = (nal: Uint8Array) => (nal[0]! >> 1) & 0x3f;
/** IRAP pictures (BLA, IDR, CRA) start a decodable sequence. */
export const h265IsKey = (type: number) => type >= 16 && type <= 23;

export interface H265Sps {
  profileSpace: number;
  tier: number;
  profile: number;
  compatibility: number;
  /** 6 bytes */
  constraints: Uint8Array;
  level: number;
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  maxSubLayers: number;
  temporalIdNested: number;
  width: number;
  height: number;
}

export function parseH265Sps(nal: Uint8Array): H265Sps {
  const r = new BitReader(unescapeRbsp(nal.subarray(2)));
  r.skip(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3);
  const temporalIdNested = r.bit();
  const profileSpace = r.bits(2);
  const tier = r.bit();
  const profile = r.bits(5);
  const compatibility = r.bits(32) >>> 0;
  const constraints = new Uint8Array(6);
  for (let i = 0; i < 6; i++) constraints[i] = r.bits(8);
  const level = r.bits(8);
  const subProfile: number[] = [];
  const subLevel: number[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.bit());
    subLevel.push(r.bit());
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) r.skip(88);
    if (subLevel[i]) r.skip(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormat = r.ue();
  if (chromaFormat === 3) r.skip(1);
  let width = r.ue();
  let height = r.ue();
  if (r.bit()) {
    const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const subH = chromaFormat === 1 ? 2 : 1;
    const [l, rt, t, b] = [r.ue(), r.ue(), r.ue(), r.ue()];
    width -= subW * (l + rt);
    height -= subH * (t + b);
  }
  const bitDepthLuma = r.ue() + 8;
  const bitDepthChroma = r.ue() + 8;
  return { profileSpace, tier, profile, compatibility, constraints, level, chromaFormat, bitDepthLuma, bitDepthChroma, maxSubLayers: maxSubLayersMinus1 + 1, temporalIdNested, width, height };
}

function reverseBits32(v: number): number {
  let out = 0;
  for (let i = 0; i < 32; i++) out = (out * 2) + ((v >>> i) & 1);
  return out >>> 0;
}

export function h265Config(vps: Uint8Array, sps: Uint8Array, pps: Uint8Array): VideoConfig {
  const s = parseH265Sps(sps);
  const head: number[] = [
    1,
    (s.profileSpace << 6) | (s.tier << 5) | s.profile,
    (s.compatibility >>> 24) & 0xff,
    (s.compatibility >>> 16) & 0xff,
    (s.compatibility >>> 8) & 0xff,
    s.compatibility & 0xff,
    ...s.constraints,
    s.level,
    0xf0,
    0x00,
    0xfc,
    0xfc | s.chromaFormat,
    0xf8 | (s.bitDepthLuma - 8),
    0xf8 | (s.bitDepthChroma - 8),
    0,
    0,
    (s.maxSubLayers << 3) | (s.temporalIdNested << 2) | 3,
    3,
  ];
  const arrays: number[] = [];
  for (const [type, nal] of [[H265.VPS, vps], [H265.SPS, sps], [H265.PPS, pps]] as const) arrays.push(0x80 | type, 0, 1, nal.length >> 8, nal.length & 0xff, ...nal);
  const constraintBytes = [...s.constraints];
  while (constraintBytes.length && constraintBytes.at(-1) === 0) constraintBytes.pop();
  const space = s.profileSpace ? String.fromCharCode(64 + s.profileSpace) : '';
  const mime = [`hvc1.${space}${s.profile}`, reverseBits32(s.compatibility).toString(16).toUpperCase(), `${s.tier ? 'H' : 'L'}${s.level}`, ...constraintBytes.map((b) => hex(b))].join('.');
  return {
    codec: 'h265',
    mime,
    width: s.width,
    height: s.height,
    record: Uint8Array.from([...head, ...arrays]),
    key: Buffer.concat([vps, sps, pps]).toString('base64'),
  };
}

// ---------------------------------------------------------------- AAC

export interface AudioConfig {
  /** "mp4a.40.2" */
  mime: string;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig */
  asc: Uint8Array;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export function aacConfig(ascHex: string): AudioConfig {
  const asc = Uint8Array.from(Buffer.from(ascHex, 'hex'));
  const r = new BitReader(asc);
  let objectType = r.bits(5);
  if (objectType === 31) objectType = 32 + r.bits(6);
  const idx = r.bits(4);
  const sampleRate = idx === 15 ? r.bits(24) : (AAC_RATES[idx] ?? 0);
  const channels = r.bits(4);
  return { mime: `mp4a.40.${objectType}`, sampleRate, channels, asc };
}
