import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FakeCamera,
  StreamHub,
  RtspSession,
  VideoDepacketizer,
  boxes,
  fragment,
  framesFromAnnexB,
  h264Config,
  h265Config,
  initSegment,
  packetize,
  parseH264Sps,
  parseH265Sps,
  parseRtp,
  parseSdp,
  splitAnnexB,
  type Viewer,
  type VideoConfig,
  type VideoFrame,
} from '../src/index.ts';

const H264_CLIP = readFileSync(new URL('./fixtures/clip.h264', import.meta.url));
const H265_CLIP = readFileSync(new URL('./fixtures/clip.h265', import.meta.url));

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(10);
  }
}

/** Walks into nested boxes by path, e.g. "moov/trak/mdia". */
function find(data: Uint8Array, path: string): Uint8Array | undefined {
  let cur: Uint8Array | undefined = data;
  for (const type of path.split('/')) {
    const skip = type === 'stsd' ? 8 : 0;
    const hit: { body: Uint8Array } | undefined = boxes(cur!).find((b) => b.type === type);
    if (!hit) return undefined;
    cur = hit.body.subarray(skip);
  }
  return cur;
}

test('parameter sets: real VideoToolbox clips', () => {
  const nals = splitAnnexB(H264_CLIP);
  const sps = nals.find((n) => (n[0]! & 0x1f) === 7)!;
  const pps = nals.find((n) => (n[0]! & 0x1f) === 8)!;
  assert.deepEqual(parseH264Sps(sps), { profile: 77, constraints: 0, level: 13, chromaFormat: 1, bitDepthLuma: 8, bitDepthChroma: 8, width: 320, height: 240 });
  const cfg = h264Config(sps, pps);
  assert.equal(cfg.mime, 'avc1.4D000D');
  assert.equal(cfg.record[0], 1);
  const h = splitAnnexB(H265_CLIP);
  const t = (type: number) => h.find((n) => ((n[0]! >> 1) & 0x3f) === type)!;
  const hc = h265Config(t(32), t(33), t(34));
  assert.deepEqual([hc.mime, hc.width, hc.height], ['hvc1.1.6.L60.B0', 320, 240]);
  // 1080p is coded as 1920x1088 and cropped (real VideoToolbox parameter sets).
  const s = parseH264Sps(Buffer.from('274d0028ab403c0113f2a0', 'hex'));
  assert.deepEqual([s.width, s.height, s.profile, s.level], [1920, 1080, 77, 40]);
  const hs = parseH265Sps(Buffer.from('420101016000000300b00000030000030078a003c0801107cb8817b916452ffcb9fc4fe880', 'hex'));
  assert.deepEqual([hs.width, hs.height], [1920, 1080]);
});

test('SDP and RTP depacketization (single, STAP-A, FU-A, loss)', () => {
  const sdp = parseSdp('v=0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1; sprop-parameter-sets=Z0IAH5WoFAFuQA==,aM48gA==\r\na=control:trackID=0\r\nm=audio 0 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/16000/1\r\na=fmtp:97 streamtype=5;mode=AAC-hbr;config=1408;sizelength=13;indexlength=3\r\n');
  assert.equal(sdp.media[0]!.encoding, 'H264');
  assert.equal(sdp.media[0]!.fmtp['sprop-parameter-sets'], 'Z0IAH5WoFAFuQA==,aM48gA==');
  assert.equal(sdp.media[1]!.channels, 1);

  const { frames, params } = framesFromAnnexB('h264', H264_CLIP);
  assert.equal(frames.length, 30);
  assert.equal(frames.filter((f) => f.key).length, 2);
  const dep = new VideoDepacketizer('h264');
  const seq = { n: 65530 }; // crosses the 16-bit wrap
  const got: VideoFrame[] = [];
  frames.forEach((f, i) => {
    for (const pkt of packetize('h264', f.nalus, i * 6000, seq, 96, 300)) got.push(...dep.push(parseRtp(pkt)!));
  });
  assert.equal(got.length, 30);
  assert.ok(got[0]!.key);
  assert.deepEqual(dep.params.sps, params[0]);
  // Parameter sets / SEI are out of the frames' NAL list except SEI; slices are intact.
  assert.deepEqual(got[1]!.nalus, frames[1]!.nalus);

  // STAP-A carrying SPS + PPS
  const stap = Buffer.concat([Buffer.from([0x80, 0x60, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 24]), Buffer.from([0, params[0]!.length]), params[0]!, Buffer.from([0, params[1]!.length]), params[1]!]);
  const d2 = new VideoDepacketizer('h264');
  d2.push(parseRtp(stap)!);
  assert.deepEqual([d2.params.sps, d2.params.pps], [params[0], params[1]]);

  // A lost packet: that frame and everything until the next keyframe are dropped.
  const d3 = new VideoDepacketizer('h264');
  const s3 = { n: 0 };
  const out: VideoFrame[] = [];
  frames.forEach((f, i) => {
    const pkts = packetize('h264', f.nalus, i * 6000, s3, 96, 300);
    if (i === 3) pkts.splice(0, 1);
    for (const p of pkts) out.push(...d3.push(parseRtp(p)!));
  });
  assert.equal(out.length, 3 + 15, 'frames 0-2, then from the second keyframe on');
  assert.ok(out[3]!.key);
});

test('H.265 depacketization (FU)', () => {
  const { frames } = framesFromAnnexB('h265', H265_CLIP);
  const dep = new VideoDepacketizer('h265');
  const seq = { n: 0 };
  const got: VideoFrame[] = [];
  frames.forEach((f, i) => {
    for (const pkt of packetize('h265', f.nalus, i * 6000, seq, 96, 200)) got.push(...dep.push(parseRtp(pkt)!));
  });
  assert.equal(got.length, frames.length);
  assert.ok(dep.params.vps && dep.params.sps && dep.params.pps);
  assert.ok(got[0]!.key);
});

test('fragmented MP4: init segment and fragments parse back', () => {
  const nals = splitAnnexB(H264_CLIP);
  const cfg = h264Config(nals.find((n) => (n[0]! & 0x1f) === 7)!, nals.find((n) => (n[0]! & 0x1f) === 8)!);
  const init = initSegment(cfg, { mime: 'mp4a.40.2', sampleRate: 16000, channels: 1, asc: Uint8Array.of(0x14, 0x08) });
  assert.deepEqual(boxes(init).map((b) => b.type), ['ftyp', 'moov']);
  assert.deepEqual(boxes(find(init, 'moov')!).map((b) => b.type), ['mvhd', 'trak', 'trak', 'mvex']);
  const stsd = find(init, 'moov/trak/mdia/minf/stbl/stsd')!;
  const avc1 = boxes(stsd)[0]!;
  assert.equal(avc1.type, 'avc1');
  const view = new DataView(avc1.body.buffer, avc1.body.byteOffset);
  assert.deepEqual([view.getUint16(24), view.getUint16(26)], [320, 240]);
  assert.ok(boxes(avc1.body.subarray(78)).some((b) => b.type === 'avcC'));

  const samples = [{ data: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88), duration: 6000, key: true }];
  const frag = fragment(1, 7, 123456789012, samples);
  const [moof, mdat] = boxes(frag);
  assert.deepEqual([moof!.type, mdat!.type], ['moof', 'mdat']);
  assert.deepEqual([...mdat!.body], [0, 0, 0, 2, 0x65, 0x88]);
  const traf = find(frag, 'moof/traf')!;
  const tfdt = boxes(traf).find((b) => b.type === 'tfdt')!;
  const tv = new DataView(tfdt.body.buffer, tfdt.body.byteOffset);
  assert.equal(tv.getUint32(4) * 2 ** 32 + tv.getUint32(8), 123456789012);
  const trun = boxes(traf).find((b) => b.type === 'trun')!;
  const rv = new DataView(trun.body.buffer, trun.body.byteOffset);
  assert.equal(rv.getUint32(4), 1, 'sample count');
  assert.equal(rv.getUint32(8), moof!.size + 8, 'data offset points into mdat');
  assert.deepEqual([rv.getUint32(12), rv.getUint32(16), rv.getUint32(20)], [6000, 6, 0x02000000]);
});

test('RTSP client against a camera with Digest auth (real H.264 clip)', async () => {
  const cam = new FakeCamera({ codec: 'h264', annexB: H264_CLIP, fps: 30, username: 'admin', password: 'pa:ss' });
  const port = await cam.listen();
  const session = new RtspSession({ url: `rtsp://127.0.0.1:${port}/stream1`, username: 'admin', password: 'pa:ss' });
  const frames: VideoFrame[] = [];
  let config: VideoConfig | undefined;
  session.on('config', (c: VideoConfig) => (config = c));
  session.on('video', (f: VideoFrame) => frames.push(f));
  try {
    await session.start();
    assert.deepEqual([config?.mime, config?.width, config?.height], ['avc1.4D000D', 320, 240]);
    await until(() => frames.length >= 20);
    assert.ok(frames[0]!.key, 'starts at the keyframe announced by the SDP');
    assert.ok(frames.every((f, i) => i === 0 || ((f.timestamp - frames[i - 1]!.timestamp) >>> 0) === 3000));
    assert.deepEqual(cam.requests.slice(0, 5), ['OPTIONS', 'DESCRIBE', 'DESCRIBE', 'SETUP', 'PLAY'], 'DESCRIBE retried once with Digest credentials');
  } finally {
    session.close();
  }
  const bad = new RtspSession({ url: `rtsp://127.0.0.1:${port}/stream1`, username: 'admin', password: 'wrong', timeoutMs: 2000 });
  await assert.rejects(bad.start(), /rejected the username or password/);
  bad.close();
  cam.close();
});

function fakeViewer() {
  const json: Record<string, unknown>[] = [];
  const binary: Uint8Array[] = [];
  let buffered = 0;
  const viewer: Viewer = { sendJson: (m) => json.push(m), sendBinary: (d) => binary.push(d), buffered: () => buffered };
  return { viewer, json, binary, setBuffered: (n: number) => (buffered = n) };
}

/** Video fragments' sample flags: true = sync sample. */
const syncFlags = (frags: Uint8Array[]) =>
  frags.slice(1).map((f) => {
    const trun = boxes(find(f, 'moof/traf')!).find((b) => b.type === 'trun')!;
    return new DataView(trun.body.buffer, trun.body.byteOffset).getUint32(20) === 0x02000000;
  });

test('StreamHub: one camera connection for many viewers, late joiners start at a keyframe, idle stop', async () => {
  const cam = new FakeCamera({ codec: 'h265', annexB: H265_CLIP, fps: 30, username: 'u', password: 'p' });
  const port = await cam.listen();
  const states: Record<string, unknown>[] = [];
  const hub = new StreamHub({ source: () => ({ url: `rtsp://127.0.0.1:${port}/live`, username: 'u', password: 'p' }), onState: (_k, s) => states.push({ ...s }), idleMs: 300 });
  try {
    const a = fakeViewer();
    const stopA = hub.watch('cam1', a.viewer);
    await until(() => a.binary.length >= 12);
    assert.equal(a.json[0]!.type, 'init');
    assert.equal(a.json[0]!.mime, 'video/mp4; codecs="hvc1.1.6.L60.B0"');
    assert.equal(boxes(a.binary[0]!)[0]!.type, 'ftyp');
    assert.equal(syncFlags(a.binary)[0], true, 'first fragment is a keyframe');

    const b = fakeViewer();
    const stopB = hub.watch('cam1', b.viewer);
    assert.equal(b.json[0]!.type, 'init');
    assert.equal(syncFlags(b.binary)[0], true, 'late joiner gets the GOP from its keyframe');
    await until(() => b.binary.length >= a.binary.length - 12 + 5);
    assert.equal(cam.connections, 1, 'one upstream connection');

    // A slow viewer skips to the next keyframe instead of queueing.
    b.setBuffered(10 * 1024 * 1024);
    const before = b.binary.length;
    await sleep(200);
    assert.equal(b.binary.length, before);
    b.setBuffered(0);
    await until(() => b.binary.length > before, 3000);
    assert.equal(syncFlags([new Uint8Array(), b.binary[before]!])[0], true, 'resumes on a keyframe');

    assert.ok(states.some((s) => s.streaming === true));
    assert.ok(states.some((s) => s.codec === 'h265' && s.width === 320));
    stopA();
    stopB();
    await until(() => states.at(-1)?.streaming === false, 2000);
    await until(() => cam.requests.includes('TEARDOWN'), 2000);
  } finally {
    hub.close();
    cam.close();
  }
});

test('StreamHub: reconnects after the camera drops, reports errors to viewers', async () => {
  const cam = new FakeCamera({ codec: 'h264', annexB: H264_CLIP, fps: 30 });
  const port = await cam.listen();
  const hub = new StreamHub({ source: () => ({ url: `rtsp://127.0.0.1:${port}/live` }), backoffMs: [50], idleMs: 100 });
  try {
    const v = fakeViewer();
    const stop = hub.watch('c', v.viewer);
    await until(() => v.binary.length > 3);
    cam.dropClients();
    await until(() => v.json.some((m) => m.type === 'status' && m.state === 'reconnecting'));
    await until(() => cam.connections >= 2);
    const n = v.binary.length;
    await until(() => v.binary.length > n + 3);
    stop();
  } finally {
    hub.close();
    cam.close();
  }
  // Nothing listening: the viewer hears why.
  const hub2 = new StreamHub({ source: () => ({ url: 'rtsp://127.0.0.1:9/none' }), backoffMs: [10_000] });
  const v2 = fakeViewer();
  const stop2 = hub2.watch('x', v2.viewer);
  await until(() => v2.json.some((m) => m.type === 'status'));
  stop2();
  hub2.close();
});
