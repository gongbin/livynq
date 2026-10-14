import type { CameraSource } from '@livynq/model';
import type { AudioConfig, VideoConfig } from './codecs.ts';
import { AUDIO_TRACK, VIDEO_TRACK, fragment, initSegment, lengthPrefixed } from './fmp4.ts';
import type { VideoFrame } from './rtp.ts';
import { RtspSession } from './rtsp.ts';

/**
 * One upstream RTSP session per camera, shared by every viewer. The session starts with the
 * first viewer and closes a while after the last one leaves. New viewers get the init segment
 * and the current GOP (from the last keyframe), so the picture appears immediately.
 */

export interface StreamInfo {
  codec: 'h264' | 'h265';
  width: number;
  height: number;
  hasAudio: boolean;
  /** MediaSource type, e.g. video/mp4; codecs="avc1.4D401F,mp4a.40.2" */
  mime: string;
}

/** A browser connection (WebSocket). */
export interface Viewer {
  sendJson(msg: Record<string, unknown>): void;
  sendBinary(data: Uint8Array): void;
  /** Bytes queued but not yet sent (WebSocket.bufferedAmount) */
  buffered(): number;
}

export interface CameraState {
  streaming?: boolean;
  codec?: 'h264' | 'h265';
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export interface StreamHubOptions {
  source(key: string): CameraSource | undefined;
  onState?(key: string, state: CameraState): void;
  log?: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void };
  /** Keep the camera connection this long after the last viewer leaves */
  idleMs?: number;
  /** A viewer whose socket holds more than this skips ahead to the next keyframe */
  maxBufferedBytes?: number;
  connect?(source: CameraSource): RtspSession;
  backoffMs?: number[];
}

interface ViewerState {
  viewer: Viewer;
  /** waits for the next keyframe (joined mid-GOP after a re-init, or fell behind) */
  waitKey: boolean;
}

/** Signed difference of two 32-bit RTP timestamps (handles wrap-around). */
const delta32 = (prev: number, ts: number): number => (ts - prev) | 0;

class Stream {
  readonly key: string;
  readonly viewers = new Map<Viewer, ViewerState>();
  session: RtspSession | undefined;
  video: VideoConfig | undefined;
  audio: AudioConfig | undefined;
  init: Uint8Array | undefined;
  info: StreamInfo | undefined;
  /** fragments since the last video keyframe (video + audio) */
  gop: { data: Uint8Array; key: boolean }[] = [];
  seq = 1;
  // video timeline (90 kHz, unwrapped)
  vLast: number | undefined;
  vTime = 0;
  vPending: { frame: VideoFrame; time: number } | undefined;
  vLastDuration = 3000;
  // audio timeline (sample rate)
  aLast: number | undefined;
  aTime = 0;
  idleTimer: NodeJS.Timeout | undefined;
  retryTimer: NodeJS.Timeout | undefined;
  failures = 0;
  lastError: string | undefined;
  starting = false;

  constructor(key: string) {
    this.key = key;
  }

  resetTimeline(): void {
    this.gop = [];
    this.vLast = undefined;
    this.vPending = undefined;
    this.aLast = undefined;
  }
}

export class StreamHub {
  readonly #opts: Required<Pick<StreamHubOptions, 'idleMs' | 'maxBufferedBytes' | 'backoffMs'>> & StreamHubOptions;
  readonly #streams = new Map<string, Stream>();

  constructor(opts: StreamHubOptions) {
    this.#opts = { idleMs: 20_000, maxBufferedBytes: 4 * 1024 * 1024, backoffMs: [1000, 2000, 5000, 10_000, 30_000], ...opts };
  }

  /** Adds a viewer; returns the function that removes it. */
  watch(key: string, viewer: Viewer): () => void {
    let s = this.#streams.get(key);
    if (!s) this.#streams.set(key, (s = new Stream(key)));
    clearTimeout(s.idleTimer);
    const state: ViewerState = { viewer, waitKey: false };
    s.viewers.set(viewer, state);
    if (s.init && s.info) {
      viewer.sendJson({ type: 'init', ...s.info });
      viewer.sendBinary(s.init);
      for (const f of s.gop) viewer.sendBinary(f.data);
    } else if (s.lastError) viewer.sendJson({ type: 'status', state: 'reconnecting', error: s.lastError });
    if (!s.session && !s.starting && !s.retryTimer) void this.#start(s);
    const stream = s;
    return () => {
      stream.viewers.delete(viewer);
      if (stream.viewers.size) return;
      clearTimeout(stream.idleTimer);
      stream.idleTimer = setTimeout(() => this.#stop(stream), this.#opts.idleMs);
      stream.idleTimer.unref?.();
    };
  }

  /** The camera's source changed or went away: reconnect (or drop) active streams. */
  invalidate(key: string): void {
    const s = this.#streams.get(key);
    if (!s) return;
    const viewers = s.viewers.size;
    this.#stop(s, true);
    if (viewers && this.#opts.source(key)) {
      this.#streams.set(key, s);
      s.resetTimeline();
      s.init = undefined;
      void this.#start(s);
    } else for (const v of s.viewers.keys()) v.sendJson({ type: 'error', message: 'This camera is no longer available' });
  }

  info(key: string): StreamInfo | undefined {
    return this.#streams.get(key)?.info;
  }

  viewers(key: string): number {
    return this.#streams.get(key)?.viewers.size ?? 0;
  }

  close(): void {
    for (const s of [...this.#streams.values()]) this.#stop(s);
  }

  async #start(s: Stream): Promise<void> {
    const source = this.#opts.source(s.key);
    if (!source) {
      for (const v of s.viewers.keys()) v.sendJson({ type: 'error', message: 'No stream source for this camera (is its integration running?)' });
      return;
    }
    s.starting = true;
    clearTimeout(s.retryTimer);
    s.retryTimer = undefined;
    const session = this.#opts.connect ? this.#opts.connect(source) : new RtspSession({ url: source.url, username: source.username, password: source.password });
    s.session = session;
    session.on('config', (cfg: VideoConfig) => this.#onConfig(s, session, cfg));
    session.on('video', (frame: VideoFrame) => s.session === session && this.#onVideo(s, frame));
    session.on('audio', (au: { data: Uint8Array; timestamp: number }) => s.session === session && this.#onAudio(s, au));
    session.on('close', (err?: Error) => {
      if (s.session !== session) return;
      s.session = undefined;
      this.#state(s, { streaming: false });
      if (!err || !s.viewers.size) return;
      this.#retry(s, err);
    });
    try {
      await session.start();
      s.starting = false;
      s.failures = 0;
      s.lastError = undefined;
      this.#opts.log?.info('camera stream started', { camera: s.key, url: session.url });
      this.#state(s, { streaming: true });
      if (!s.viewers.size) {
        clearTimeout(s.idleTimer);
        s.idleTimer = setTimeout(() => this.#stop(s), this.#opts.idleMs);
      }
    } catch (err) {
      s.starting = false;
      if (s.session === session) {
        s.session = undefined;
        session.close();
        this.#retry(s, err as Error);
      }
    }
  }

  #retry(s: Stream, err: Error): void {
    s.lastError = err.message;
    const delay = this.#opts.backoffMs[Math.min(s.failures, this.#opts.backoffMs.length - 1)]!;
    s.failures++;
    this.#opts.log?.warn('camera stream failed', { camera: s.key, error: err.message, retryInMs: delay });
    for (const v of s.viewers.keys()) v.sendJson({ type: 'status', state: 'reconnecting', error: err.message, retryInMs: delay });
    if (!s.viewers.size) return;
    clearTimeout(s.retryTimer);
    s.retryTimer = setTimeout(() => {
      s.retryTimer = undefined;
      if (s.viewers.size && !s.session) void this.#start(s);
    }, delay);
    s.retryTimer.unref?.();
  }

  #stop(s: Stream, keepEntry = false): void {
    clearTimeout(s.idleTimer);
    clearTimeout(s.retryTimer);
    s.retryTimer = undefined;
    const session = s.session;
    s.session = undefined;
    session?.close();
    if (!keepEntry || !s.viewers.size) this.#streams.delete(s.key);
    this.#state(s, { streaming: false });
  }

  #state(s: Stream, state: CameraState): void {
    try {
      this.#opts.onState?.(s.key, state);
    } catch {
      // the device may be gone
    }
  }

  #onConfig(s: Stream, session: RtspSession, video: VideoConfig): void {
    if (s.session !== session) return;
    const audio = session.audio;
    const changed = s.video !== undefined;
    s.video = video;
    s.audio = audio;
    s.init = initSegment(video, audio);
    s.info = {
      codec: video.codec,
      width: video.width,
      height: video.height,
      hasAudio: Boolean(audio),
      mime: `video/mp4; codecs="${video.mime}${audio ? `,${audio.mime}` : ''}"`,
    };
    this.#state(s, { codec: video.codec, width: video.width, height: video.height, hasAudio: Boolean(audio) });
    if (changed) s.resetTimeline();
    // Everyone (re)starts from the next keyframe with the new description.
    for (const [v, st] of s.viewers) {
      v.sendJson({ type: 'init', ...s.info });
      v.sendBinary(s.init);
      st.waitKey = true;
    }
  }

  #onVideo(s: Stream, frame: VideoFrame): void {
    if (!s.init) return;
    if (s.vLast === undefined) {
      if (!frame.key) return; // start every timeline on a keyframe
      s.vTime = 0;
    } else {
      const diff = delta32(s.vLast, frame.timestamp);
      // A jump backwards or of more than 10 s is a camera restart: continue smoothly.
      const step = diff > 0 && diff < 900_000 ? diff : s.vLastDuration;
      if (s.vPending) this.#emitVideo(s, s.vPending.frame, s.vPending.time, step);
      s.vTime += step;
      s.vLastDuration = step;
    }
    s.vLast = frame.timestamp;
    s.vPending = { frame, time: s.vTime };
  }

  #emitVideo(s: Stream, frame: VideoFrame, time: number, duration: number): void {
    const data = fragment(VIDEO_TRACK, s.seq++, time, [{ data: lengthPrefixed(frame.nalus), duration, key: frame.key }]);
    if (frame.key) s.gop = [];
    s.gop.push({ data, key: frame.key });
    if (s.gop.length > 600) s.gop.splice(1, 1); // keep it bounded on cameras with very long GOPs
    for (const st of s.viewers.values()) this.#send(st, data, frame.key);
  }

  #onAudio(s: Stream, au: { data: Uint8Array; timestamp: number }): void {
    if (!s.init || !s.audio || s.vLast === undefined) return; // audio starts with the video timeline
    if (s.aLast === undefined) {
      // Align the first audio frame with the current video position (no RTCP: approximate sync).
      s.aTime = Math.round((s.vTime / 90000) * s.audio.sampleRate);
    } else {
      const diff = delta32(s.aLast, au.timestamp);
      s.aTime += diff > 0 && diff < s.audio.sampleRate * 10 ? diff : 1024;
    }
    s.aLast = au.timestamp;
    const data = fragment(AUDIO_TRACK, s.seq++, s.aTime, [{ data: au.data, duration: 1024, key: true }]);
    s.gop.push({ data, key: false });
    for (const st of s.viewers.values()) this.#send(st, data, false, true);
  }

  #send(st: ViewerState, data: Uint8Array, key: boolean, audio = false): void {
    if (st.waitKey) {
      if (!key || audio) return;
      st.waitKey = false;
    }
    if (st.viewer.buffered() > this.#opts.maxBufferedBytes) {
      st.waitKey = true; // too slow: skip to the next keyframe instead of growing the queue
      return;
    }
    st.viewer.sendBinary(data);
  }
}
