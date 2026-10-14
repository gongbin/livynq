import { useEffect, useRef, useState, type ReactNode } from 'react';
import { auth } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { Icon } from './icons.tsx';
import { Spinner, cx } from './ui.tsx';

/**
 * Camera live view: the hub sends fragmented MP4 over a WebSocket (init message, init segment,
 * then one fragment per frame); we feed it to Media Source Extensions — ManagedMediaSource on
 * iPhone (iOS 17.1+), MediaSource elsewhere — and keep the playhead at the live edge.
 */

const enc = encodeURIComponent;

export function cameraPath(deviceId: string, endpointId: number, what: 'live' | 'snapshot.jpg'): string {
  return `/api/v1/cameras/${enc(deviceId)}/${endpointId}/${what}?token=${enc(auth.get() ?? '')}`;
}

type MS = typeof MediaSource;
function mediaSourceCtor(): (MS & { managed?: boolean }) | undefined {
  const w = window as unknown as { ManagedMediaSource?: MS; MediaSource?: MS };
  if (w.ManagedMediaSource) return Object.assign(w.ManagedMediaSource, { managed: true });
  return w.MediaSource;
}

type PlayerState = { kind: 'connecting' } | { kind: 'playing' } | { kind: 'reconnecting'; message?: string } | { kind: 'error'; message: string };

interface InitMsg {
  type: 'init';
  mime: string;
  codec: string;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Keeps at most this many seconds behind the playhead and jumps forward when lagging. */
const KEEP_BEHIND = 20;
const MAX_LAG = 1.5;

export function CameraPlayer({ deviceId, endpointId, className, onInfo }: { deviceId: string; endpointId: number; className?: string; onInfo?: (info: InitMsg) => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PlayerState>({ kind: 'connecting' });
  const [info, setInfo] = useState<InitMsg | null>(null);
  const [muted, setMuted] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const infoRef = useRef(onInfo);
  infoRef.current = onInfo;

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let closed = false;
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let ms: MediaSource | undefined;
    let sb: SourceBuffer | undefined;
    let objectUrl: string | undefined;
    let queue: ArrayBuffer[] = [];
    let started = false;

    const teardownMedia = () => {
      queue = [];
      sb = undefined;
      started = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
      ms = undefined;
      el.removeAttribute('src');
      el.load();
    };

    const pump = () => {
      if (!sb || sb.updating || !queue.length || ms?.readyState !== 'open') return;
      const next = queue.shift()!;
      try {
        sb.appendBuffer(next);
      } catch (err) {
        if ((err as DOMException).name === 'QuotaExceededError') {
          queue.unshift(next);
          trim(true);
        } else fail(t('cam.err.decode'));
      }
    };

    const trim = (force = false) => {
      if (!sb || sb.updating || !sb.buffered.length) return;
      const start = sb.buffered.start(0);
      const behind = el.currentTime - start;
      if (behind > KEEP_BEHIND || (force && behind > 2)) {
        try {
          sb.remove(start, el.currentTime - (force ? 1 : 5));
        } catch {
          // removal will be retried on the next update
        }
      }
    };

    const followLive = () => {
      if (!sb || !sb.buffered.length) return;
      const end = sb.buffered.end(sb.buffered.length - 1);
      if (!started) {
        started = true;
        el.currentTime = Math.max(sb.buffered.start(0), end - 0.2);
        void el.play().catch(() => {});
        setState({ kind: 'playing' });
      } else if (end - el.currentTime > MAX_LAG) el.currentTime = end - 0.3;
      if (el.paused && !document.hidden) void el.play().catch(() => {});
    };

    const fail = (message: string) => {
      setState({ kind: 'error', message });
      closed = true;
      ws?.close();
    };

    const setup = (init: InitMsg) => {
      teardownMedia();
      const Ctor = mediaSourceCtor();
      if (!Ctor) return fail(t('cam.err.noMse'));
      if (!Ctor.isTypeSupported(init.mime)) return fail(init.codec === 'h265' ? t('cam.err.hevc') : t('cam.err.codec', { mime: init.mime }));
      ms = new Ctor();
      if (Ctor.managed) el.disableRemotePlayback = true;
      objectUrl = URL.createObjectURL(ms);
      el.src = objectUrl;
      const source = ms;
      source.addEventListener(
        'sourceopen',
        () => {
          if (source !== ms) return;
          try {
            sb = source.addSourceBuffer(init.mime);
            sb.mode = 'segments';
            sb.addEventListener('updateend', () => {
              followLive();
              trim();
              pump();
            });
            pump();
          } catch {
            fail(t('cam.err.codec', { mime: init.mime }));
          }
        },
        { once: true },
      );
    };

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}${cameraPath(deviceId, endpointId, 'live')}`);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data) as { type: string; message?: string; error?: string } & Partial<InitMsg>;
          if (msg.type === 'init') {
            attempt = 0;
            setInfo(msg as InitMsg);
            infoRef.current?.(msg as InitMsg);
            setup(msg as InitMsg);
          } else if (msg.type === 'status') setState({ kind: 'reconnecting', message: msg.error });
          else if (msg.type === 'error') fail(msg.message ?? t('cam.err.generic'));
          return;
        }
        queue.push(e.data as ArrayBuffer);
        if (queue.length > 300) queue.splice(0, queue.length - 300);
        pump();
      };
      ws.onclose = () => {
        if (closed) return;
        setState((s) => (s.kind === 'error' ? s : { kind: 'reconnecting' }));
        retry = setTimeout(connect, Math.min(10_000, 1000 * 2 ** attempt++));
      };
    };

    // Pause the stream (and the camera connection) while the page is hidden.
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(retry);
        ws?.close();
        ws = undefined;
        teardownMedia();
      } else if (!ws && !closed) {
        setState({ kind: 'connecting' });
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisibility);
      ws?.close();
      teardownMedia();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, endpointId]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    const el = box.current;
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    else v?.webkitEnterFullscreen?.();
  };

  return (
    <div ref={box} className={cx('group relative shrink-0 overflow-hidden bg-black', fullscreen ? 'grid place-items-center' : 'aspect-video rounded-[16px]', className)}>
      <video ref={video} muted={muted} playsInline autoPlay className="size-full object-contain" aria-label={t('cam.liveView')} />
      {state.kind !== 'playing' && (
        <div className="absolute inset-0 grid place-items-center bg-black/55 p-4 text-center text-[13px] text-white">
          {state.kind === 'error' ? (
            <span className="flex max-w-xs flex-col items-center gap-2">
              <Icon name="alert" size={22} />
              {state.message}
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2">
              <Spinner size={20} />
              {state.kind === 'reconnecting' ? (state.message ? t('cam.reconnectingWhy', { why: state.message }) : t('cam.reconnecting')) : t('cam.connecting')}
            </span>
          )}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-2.5">
        {state.kind === 'playing' && (
          <span className="flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold tracking-wide text-white">
            <span className="size-1.5 animate-pulse rounded-full bg-[#ff4d4d]" />
            {t('cam.liveBadge')}
          </span>
        )}
        {info && <span className="rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10.5px] text-white/85">{`${info.width}×${info.height} · ${info.codec.toUpperCase()}`}</span>}
      </div>
      <div className="absolute right-2 bottom-2 flex gap-1.5">
        {info?.hasAudio && (
          <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? t('cam.unmute') : t('cam.mute')} className="grid size-9 place-items-center rounded-full border-0 bg-black/55 text-white">
            <Icon name={muted ? 'volumeOff' : 'volume'} size={17} />
          </button>
        )}
        <button type="button" onClick={toggleFullscreen} aria-label={fullscreen ? t('cam.exitFullscreen') : t('cam.fullscreen')} className="grid size-9 place-items-center rounded-full border-0 bg-black/55 text-white">
          <Icon name={fullscreen ? 'minimize' : 'maximize'} size={16} />
        </button>
      </div>
    </div>
  );
}

/**
 * A still that refreshes every `refreshMs` while visible. Cameras without a snapshot URL show a
 * placeholder (the live view is one tap away).
 */
export function CameraSnapshot({
  deviceId,
  endpointId,
  refreshMs = 10_000,
  className,
  offline,
  children,
}: {
  deviceId: string;
  endpointId: number;
  refreshMs?: number;
  className?: string;
  offline?: boolean;
  /** Overlay (e.g. the card's name and state) */
  children?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<'loading' | 'ok' | 'none'>('loading');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setVisible(true);
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), { rootMargin: '100px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || offline || state === 'none') return;
    const id = setInterval(() => !document.hidden && setTick(Date.now()), refreshMs);
    return () => clearInterval(id);
  }, [visible, offline, state, refreshMs]);

  return (
    <div ref={ref} className={cx('relative aspect-video shrink-0 overflow-hidden rounded-[14px] bg-[#16130f]', className)}>
      {visible && !offline && state !== 'none' && (
        <img
          src={`${cameraPath(deviceId, endpointId, 'snapshot.jpg')}&t=${tick}`}
          alt=""
          draggable={false}
          onLoad={() => setState('ok')}
          onError={() => setState((s) => (s === 'ok' ? s : 'none'))}
          className={cx('size-full object-cover transition-opacity duration-slow', state === 'ok' ? 'opacity-100' : 'opacity-0')}
        />
      )}
      {state !== 'ok' && (
        <div className="absolute inset-0 grid place-items-center text-white/70">
          <span className="flex flex-col items-center gap-1.5 text-[12px] font-semibold">
            {state === 'loading' && !offline ? <Spinner size={16} /> : <Icon name={offline ? 'wifiOff' : 'camera'} size={22} />}
            {state === 'none' && !offline && t('cam.tapForLive')}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
