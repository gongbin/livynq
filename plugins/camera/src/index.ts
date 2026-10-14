import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { join } from 'node:path';
import { DeviceTypes, defineAdapter, type DeviceDefinition, type EndpointDefinition, type PluginContext, type PluginDevice } from '@livynq/sdk';

type DeviceInfo = NonNullable<DeviceDefinition['info']>;
import { OnvifCamera, OnvifError, discover, type CameraEvent, type Profile } from './onvif.ts';

/**
 * IP cameras: ONVIF (discovery, stream / snapshot URIs, motion and person events) or a plain
 * RTSP URL. The hub pulls the video itself when someone watches (ctx.media); this plugin only
 * describes the camera and reports its events.
 *
 *   plugins:
 *     - module: "@livynq/plugin-camera"
 *       config:
 *         cameras:                       # cameras added in the UI are stored in the plugin data dir
 *           - xaddr: http://192.168.1.64/onvif/device_service   # or host: 192.168.1.64
 *             username: admin
 *             password: "…"
 *             profile: sub               # main (default), sub, or a profile token
 *           - url: rtsp://192.168.1.70:554/stream1               # no ONVIF
 *             username: admin
 *             password: "…"
 *             name: Garage
 */

export interface CameraConfig {
  /** ONVIF device service URL */
  xaddr?: string;
  /** ONVIF camera by address (device service at /onvif/device_service) */
  host?: string;
  /** Plain RTSP stream */
  url?: string;
  username?: string;
  password?: string;
  name?: string;
  snapshotUrl?: string;
  /** main | sub | <profile token> */
  profile?: string;
}

interface Status {
  key: string;
  id: string | null;
  name: string;
  kind: 'onvif' | 'rtsp';
  address: string;
  state: 'connecting' | 'online' | 'offline' | 'auth' | 'error';
  error?: string;
  model?: string;
  profile?: string;
  resolution?: string;
  events: boolean;
}

const MOTION_HOLD_MS = 30_000;

export const cameraKey = (c: CameraConfig) => (c.xaddr ?? (c.host ? `http://${c.host}/onvif/device_service` : c.url ?? '')).toLowerCase();
const shortHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Picks the stream: "main" = highest resolution, "sub" = lowest, or an explicit token. */
export function pickProfile(profiles: Profile[], wanted = 'main'): Profile | undefined {
  const byToken = profiles.find((p) => p.token === wanted || p.name === wanted);
  if (byToken) return byToken;
  const video = profiles.filter((p) => p.encoding !== 'JPEG');
  const list = video.length ? video : profiles;
  const sorted = [...list].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  return wanted === 'sub' ? sorted[sorted.length - 1] : sorted[0];
}

const reachable = (url: string) =>
  new Promise<boolean>((resolve) => {
    const u = new URL(url);
    const socket = tcpConnect({ host: u.hostname, port: Number(u.port || (u.protocol === 'rtsps:' ? 322 : 554)), timeout: 4000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });

function runCamera(ctx: PluginContext, cfg: CameraConfig) {
  const key = cameraKey(cfg);
  const status: Status = {
    key,
    id: null,
    name: cfg.name ?? '',
    kind: cfg.url ? 'rtsp' : 'onvif',
    address: cfg.url ? new URL(cfg.url).host : new URL(cfg.xaddr ?? `http://${cfg.host}/`).host,
    state: 'connecting',
    events: false,
  };
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let device: PluginDevice | undefined;
  let cameraEp = 0;
  const sensors = new Map<'motion' | 'person', { ep: number; timer?: ReturnType<typeof setTimeout> }>();
  let onvif: OnvifCamera | undefined;
  let subscription: string | undefined;
  const later = (ms: number, fn: () => void) => {
    clearTimeout(timer);
    if (!closed) timer = setTimeout(fn, ms);
  };

  const fail = (err: Error) => {
    status.state = err instanceof OnvifError && err.auth ? 'auth' : 'offline';
    status.error = err.message;
    device?.setAvailability('offline');
  };

  let info: DeviceInfo = {};
  const publish = async (id: string) => {
    cameraEp = await ctx.endpointId(id, 'camera');
    const endpoints: EndpointDefinition[] = [{ id: cameraEp, deviceType: DeviceTypes.Camera.id, capabilities: ['camera'] }];
    for (const [kind, s] of sensors) endpoints.push({ id: s.ep, deviceType: DeviceTypes.OccupancySensor.id, capabilities: ['occupancySensing'], name: kind === 'motion' ? 'Motion' : 'Person' });
    device = await ctx.devices.upsert({ id, name: status.name, protocol: 'lan', info, endpoints });
    status.id = id;
  };

  const setOccupied = (kind: 'motion' | 'person', on: boolean) => {
    const s = sensors.get(kind);
    if (!s || !device) return;
    clearTimeout(s.timer);
    device.update(s.ep, 'occupancySensing', { occupied: on });
    // Some cameras only send "active"; clear it ourselves if no "inactive" follows.
    if (on) s.timer = setTimeout(() => device?.update(s.ep, 'occupancySensing', { occupied: false }), MOTION_HOLD_MS);
  };

  const onEvent = async (e: CameraEvent) => {
    if (e.kind === 'other') return;
    if (e.kind === 'person' && !sensors.has('person') && status.id) {
      // First person event: this camera does person detection; add the sensor.
      sensors.set('person', { ep: await ctx.endpointId(status.id, 'person') });
      await publish(status.id);
    }
    setOccupied(e.kind, e.active);
  };

  const pullLoop = async () => {
    if (closed || !onvif) return;
    try {
      subscription ??= await onvif.subscribe();
      let renewedAt = Date.now();
      while (!closed && subscription) {
        for (const e of await onvif.pull(subscription, 10)) await onEvent(e);
        if (Date.now() - renewedAt > 60_000) {
          await onvif.renew(subscription);
          renewedAt = Date.now();
        }
      }
    } catch (err) {
      ctx.log.debug(`${status.name}: events: ${(err as Error).message}`);
      subscription = undefined;
      later(15_000, () => void pullLoop());
    }
  };

  const startOnvif = async () => {
    const xaddr = cfg.xaddr ?? `http://${cfg.host}/onvif/device_service`;
    onvif = new OnvifCamera({ xaddr, username: cfg.username, password: cfg.password });
    info = await onvif.connect();
    const profiles = await onvif.profiles();
    const profile = pickProfile(profiles, cfg.profile);
    if (!profile) throw new OnvifError('the camera has no media profiles');
    const url = await onvif.streamUri(profile.token);
    const snapshotUrl = cfg.snapshotUrl ?? (await onvif.snapshotUri(profile.token));
    const id = `camera:${shortHash(info.serial || xaddr)}`;
    status.name = cfg.name || [info.manufacturer, info.model].filter(Boolean).join(' ') || 'Camera';
    status.model = info.model;
    status.profile = profile.name;
    status.resolution = profile.width ? `${profile.width}×${profile.height} ${profile.encoding ?? ''}`.trim() : undefined;
    status.events = onvif.hasEvents;
    if (onvif.hasEvents && !sensors.has('motion')) sensors.set('motion', { ep: await ctx.endpointId(id, 'motion') });
    await publish(id);
    ctx.media.register(id, cameraEp, { url, ...(cfg.username ? { username: cfg.username } : {}), ...(cfg.password ? { password: cfg.password } : {}), ...(snapshotUrl ? { snapshotUrl } : {}) });
    device!.setAvailability('online');
    status.state = 'online';
    delete status.error;
    ctx.log.info(`${status.name}: ${status.resolution ?? profile.name}${onvif.hasEvents ? ', events' : ''}`);
    if (onvif.hasEvents) void pullLoop();
    // Keep an eye on reachability (events loop errors alone are not conclusive).
    const watch = async () => {
      if (closed) return;
      const up = await reachable(url);
      device?.setAvailability(up ? 'online' : 'offline');
      status.state = up ? 'online' : 'offline';
      if (!up) status.error = `${new URL(url).host} does not answer`;
      setTimeout(() => void watch(), 60_000).unref();
    };
    setTimeout(() => void watch(), 60_000).unref();
  };

  const startRtsp = async () => {
    const url = new URL(cfg.url!);
    // Credentials in the URL are moved out of it.
    const username = cfg.username ?? (url.username ? decodeURIComponent(url.username) : undefined);
    const password = cfg.password ?? (url.password ? decodeURIComponent(url.password) : undefined);
    url.username = '';
    url.password = '';
    const id = `camera:${shortHash(url.toString())}`;
    status.name = cfg.name || `Camera ${url.hostname}`;
    info = { model: 'RTSP' };
    await publish(id);
    ctx.media.register(id, cameraEp, { url: url.toString(), ...(username ? { username } : {}), ...(password ? { password } : {}), ...(cfg.snapshotUrl ? { snapshotUrl: cfg.snapshotUrl } : {}) });
    const watch = async () => {
      if (closed) return;
      const up = await reachable(url.toString());
      device?.setAvailability(up ? 'online' : 'offline');
      status.state = up ? 'online' : 'offline';
      if (up) delete status.error;
      else status.error = `${url.host} does not answer`;
      later(60_000, () => void watch());
    };
    await watch();
  };

  const start = () => {
    status.state = 'connecting';
    (cfg.url ? startRtsp() : startOnvif()).catch((err: Error) => {
      fail(err);
      ctx.log.warn(`${cfg.name || status.address}: ${err.message}`);
      // Wrong credentials won't fix themselves; anything else is retried.
      if (status.state !== 'auth') later(30_000, start);
    });
  };
  start();

  return {
    status: () => status,
    id: () => status.id,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const s of sensors.values()) clearTimeout(s.timer);
      if (onvif && subscription) void onvif.unsubscribe(subscription);
      if (status.id) ctx.media.unregister(status.id, cameraEp);
    },
  };
}

export default defineAdapter({
  setup(ctx: PluginContext) {
    const file = join(ctx.dataDir, 'cameras.json');
    const configured = (Array.isArray(ctx.config.cameras) ? ctx.config.cameras : []) as CameraConfig[];
    let saved: CameraConfig[] = [];
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as CameraConfig[];
    } catch {
      // none yet
    }
    const save = () => writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    const runners = new Map<string, ReturnType<typeof runCamera>>();
    const start = (c: CameraConfig) => {
      const k = cameraKey(c);
      runners.get(k)?.close();
      runners.set(k, runCamera(ctx, c));
    };
    for (const c of [...configured, ...saved]) if (c.xaddr || c.host || c.url) start(c);

    ctx.actions.register('discover', 'ONVIF cameras answering on the LAN', async (p) => {
      const found = await discover(Number(p.timeoutMs ?? 3000), typeof p.address === 'string' ? { address: p.address, port: Number(p.port ?? 3702) } : undefined);
      return found.map((d) => ({ ...d, added: [...runners.keys()].includes(d.xaddr.toLowerCase()) }));
    });

    ctx.actions.register('add', 'Add a camera: { xaddr | host, username, password, profile? } (ONVIF) or { url, username?, password?, name? } (RTSP)', async (p) => {
      const cfg: CameraConfig = {};
      for (const k of ['xaddr', 'host', 'url', 'username', 'password', 'name', 'snapshotUrl', 'profile'] as const) {
        const v = typeof p[k] === 'string' ? (p[k] as string).trim() : '';
        if (v) cfg[k] = v;
      }
      if (!cfg.xaddr && !cfg.host && !cfg.url) throw new Error('xaddr, host or url is required');
      if (cfg.url && !/^rtsps?:\/\//i.test(cfg.url)) throw new Error('url must start with rtsp:// or rtsps://');
      let preview: { name?: string; resolution?: string } = {};
      if (!cfg.url) {
        // Check the credentials before saving.
        const cam = new OnvifCamera({ xaddr: cfg.xaddr ?? `http://${cfg.host}/onvif/device_service`, username: cfg.username, password: cfg.password });
        const info = await cam.connect();
        const profile = pickProfile(await cam.profiles(), cfg.profile);
        preview = { name: cfg.name || [info.manufacturer, info.model].filter(Boolean).join(' '), resolution: profile?.width ? `${profile.width}×${profile.height}` : undefined };
      }
      saved = [...saved.filter((s) => cameraKey(s) !== cameraKey(cfg)), cfg];
      save();
      start(cfg);
      return { added: cameraKey(cfg), ...preview };
    });

    ctx.actions.register('remove', 'Remove a camera added in the UI: { key } (from "cameras")', async (p) => {
      const k = String(p.key ?? '').toLowerCase();
      const r = runners.get(k);
      if (!r) throw new Error(`No camera ${k}`);
      const id = r.id();
      r.close();
      runners.delete(k);
      saved = saved.filter((s) => cameraKey(s) !== k);
      save();
      if (id) await ctx.devices.remove(id);
      return { removed: k };
    });

    ctx.actions.register('cameras', 'Cameras and their connection state', () => [...runners.values()].map((r) => r.status()));

    ctx.onStop(() => {
      for (const r of runners.values()) r.close();
    });
  },
});
