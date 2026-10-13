import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineAdapter, type PluginContext, type PluginDevice } from '@livynq/sdk';
import { HueError, HueEventStream, bridgeConfig, createKey, hueRequest, type HueEvent, type HueResource } from './clip.ts';
import { buttonEventToUpdate, commandToBody, mergeResource, planDevices, resourceToUpdates, serviceCommands, type ServicePlan } from './mapping.ts';

/**
 * Philips Hue bridges (v2, square) over the local CLIP v2 API and its event stream.
 *
 *   plugins:
 *     - module: "@livynq/plugin-hue"
 *       config:
 *         discovery: true          # list bridges found via mDNS (pairing needs the link button)
 *         bridges:                 # optional; bridges paired from the UI are stored in the plugin data dir
 *           - host: 192.168.1.20
 *             key: "…"             # application key ("username")
 *
 * Lights, motion / temperature / light level / contact sensors, buttons and battery levels map
 * to Livynq devices. Hue rooms, zones and scenes are not imported (yet).
 */

interface BridgeConfig {
  host: string;
  key: string;
  bridgeId?: string;
  name?: string;
}

type BridgeState = 'connecting' | 'online' | 'auth' | 'offline';

interface Bound {
  device: PluginDevice;
  service: ServicePlan;
  endpointId: number;
}

function runBridge(ctx: PluginContext, cfg: BridgeConfig) {
  const target = { host: cfg.host, key: cfg.key, bridgeId: cfg.bridgeId };
  const cache = new Map<string, HueResource>();
  const services = new Map<string, Bound>();
  const connectivity = new Map<string, PluginDevice>();
  let deviceIds = new Set<string>();
  let state: BridgeState = 'connecting';
  let closed = false;
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;

  // Hue asks for at most ~10 light commands per second.
  let queue: Promise<unknown> = Promise.resolve();
  const put = (path: string, body: unknown) => {
    const run = queue.then(async () => {
      try {
        await hueRequest(target, 'PUT', path, body);
      } finally {
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  const sync = async () => {
    const res = await hueRequest<{ data: HueResource[] }>(target, 'GET', '/clip/v2/resource');
    if (closed) return;
    cache.clear();
    for (const r of res.data) cache.set(r.id, r);
    services.clear();
    connectivity.clear();
    const plans = planDevices(res.data);
    const next = new Set<string>();
    for (const p of plans) {
      next.add(p.id);
      const bound = await Promise.all(p.services.map(async (s) => ({ service: s, endpointId: await ctx.endpointId(p.id, s.key) })));
      bound.sort((a, b) => a.endpointId - b.endpointId);
      const device = await ctx.devices.upsert({
        id: p.id,
        name: p.name,
        protocol: 'hue',
        info: { manufacturer: p.manufacturer, model: p.model, firmware: p.firmware },
        endpoints: bound.map((b) => ({ id: b.endpointId, deviceType: b.service.deviceType, capabilities: b.service.capabilities, ...(bound.length > 1 && b.service.name ? { name: b.service.name } : {}) })),
      });
      for (const b of bound) {
        services.set(b.service.rid, { device, ...b });
        const r = cache.get(b.service.rid)!;
        for (const u of resourceToUpdates(b.service, r)) device.update(b.endpointId, u.capability, u.attributes);
        for (const [capability, commands] of Object.entries(serviceCommands(b.service))) {
          device.handle(
            b.endpointId,
            capability,
            Object.fromEntries(
              commands.map((command) => [
                command,
                async (params: Record<string, unknown>) => {
                  const schema = (cache.get(b.service.rid)?.color_temperature as { mirek_schema?: { mirek_minimum: number; mirek_maximum: number } } | undefined)?.mirek_schema;
                  const body = commandToBody(capability, command, params, {
                    on: device.get(b.endpointId, 'onOff', 'onOff') === true,
                    ...(schema ? { mirek: { min: schema.mirek_minimum, max: schema.mirek_maximum } } : {}),
                  });
                  await put(`/clip/v2/resource/light/${b.service.rid}`, body);
                },
              ]),
            ),
          );
        }
      }
      if (p.connectivity) {
        connectivity.set(p.connectivity, device);
        const status = (cache.get(p.connectivity) as { status?: string } | undefined)?.status;
        device.setAvailability(status && status !== 'connected' ? 'offline' : 'online');
      } else device.setAvailability('online');
    }
    for (const id of deviceIds) if (!next.has(id)) await ctx.devices.remove(id);
    deviceIds = next;
    state = 'online';
    ctx.log.info(`${cfg.name ?? cfg.host}: ${plans.length} devices`);
  };

  const resync = (delay = 1500) => {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      void sync().catch((err: Error) => fail(err));
    }, delay);
  };

  const fail = (err: Error) => {
    if (err instanceof HueError && (err.status === 401 || err.status === 403)) state = 'auth';
    else if (state !== 'auth') state = 'offline';
    ctx.log.warn(`${cfg.name ?? cfg.host}: ${err.message}`);
  };

  const onEvents = (events: HueEvent[]) => {
    for (const e of events) {
      if (e.type === 'add' || e.type === 'delete') {
        resync();
        continue;
      }
      if (e.type !== 'update') continue;
      for (const patch of e.data) {
        const cached = cache.get(patch.id);
        if (cached) mergeResource(cached, patch);
        if (patch.type === 'device' && patch.metadata) resync();
        const dev = connectivity.get(patch.id);
        if (dev && typeof patch.status === 'string') dev.setAvailability(patch.status === 'connected' ? 'online' : 'offline');
        const b = services.get(patch.id);
        if (!b) continue;
        if (b.service.rtype === 'button') {
          const u = buttonEventToUpdate(patch);
          if (u) b.device.update(b.endpointId, u.capability, u.attributes);
          continue;
        }
        for (const u of resourceToUpdates(b.service, patch, cached ?? patch)) b.device.update(b.endpointId, u.capability, u.attributes);
      }
    }
  };

  const stream = new HueEventStream(target);
  stream.on('events', onEvents);
  // (Re)connected: whatever changed in between is only visible in a full read.
  stream.on('open', () => resync(0));
  stream.on('close', () => {
    if (state === 'online') state = 'offline';
    // The bridge is unreachable; the next full read after reconnecting restores availability.
    for (const b of new Set([...services.values()].map((s) => s.device))) b.setAvailability('offline');
  });
  stream.on('error', (err: Error) => fail(err));
  stream.connect();

  return {
    state: () => state,
    devices: () => deviceIds.size,
    deviceIds: () => [...deviceIds],
    close() {
      closed = true;
      clearTimeout(resyncTimer);
      stream.close();
    },
  };
}

export default defineAdapter({
  async setup(ctx) {
    const savedFile = join(ctx.dataDir, 'bridges.json');
    let saved: BridgeConfig[] = [];
    try {
      saved = JSON.parse(readFileSync(savedFile, 'utf8')) as BridgeConfig[];
    } catch {
      // none yet
    }
    const save = () => writeFileSync(savedFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
    const configured = (Array.isArray(ctx.config.bridges) ? ctx.config.bridges : []) as BridgeConfig[];
    const bridges = new Map<string, { cfg: BridgeConfig; run: ReturnType<typeof runBridge> }>();
    const discovered = new Map<string, { host: string; name: string; bridgeId?: string; at: number }>();
    const keyOf = (cfg: BridgeConfig) => (cfg.bridgeId ?? cfg.host).toLowerCase();

    const start = (cfg: BridgeConfig) => {
      const k = keyOf(cfg);
      bridges.get(k)?.run.close();
      bridges.set(k, { cfg, run: runBridge(ctx, cfg) });
    };
    for (const cfg of [...configured, ...saved]) if (cfg?.host && cfg.key) start(cfg);

    ctx.actions.register('pair', 'Pair a Hue bridge: press its link button, then call with { host } within 30 s', async (p) => {
      const host = String(p.host ?? '').trim();
      if (!host) throw new Error('host is required (e.g. 192.168.1.20)');
      const info = await bridgeConfig(host);
      let key: string;
      try {
        key = await createKey({ host, bridgeId: info.bridgeId }, 'livynq#hub');
      } catch (err) {
        if (err instanceof HueError && err.hueType === 101) return { paired: false, linkButton: true, bridgeId: info.bridgeId, name: info.name };
        throw err;
      }
      const cfg: BridgeConfig = { host, key, bridgeId: info.bridgeId, name: info.name };
      saved = [...saved.filter((s) => keyOf(s) !== info.bridgeId && s.host !== host), cfg];
      save();
      start(cfg);
      return { paired: true, bridgeId: info.bridgeId, name: info.name };
    });
    ctx.actions.register('bridges', 'Paired bridges and their connection state', () =>
      [...bridges.values()].map(({ cfg, run }) => ({ host: cfg.host, bridgeId: cfg.bridgeId ?? null, name: cfg.name ?? null, state: run.state(), devices: run.devices() })),
    );
    ctx.actions.register('remove', 'Forget a paired bridge and its devices: { bridgeId } or { host }', async (p) => {
      const k = String(p.bridgeId ?? p.host ?? '').toLowerCase();
      const entry = [...bridges.entries()].find(([key, b]) => key === k || b.cfg.host.toLowerCase() === k);
      if (!entry) throw new Error(`No paired bridge ${k}`);
      const [key, b] = entry;
      b.run.close();
      bridges.delete(key);
      for (const id of b.run.deviceIds()) await ctx.devices.remove(id);
      saved = saved.filter((s) => keyOf(s) !== key);
      save();
      return { removed: key };
    });
    ctx.actions.register('discovered', 'Hue bridges found on the network via mDNS', () =>
      [...discovered.values()].map((d) => ({ ...d, paired: [...bridges.values()].some((b) => (d.bridgeId && b.cfg.bridgeId === d.bridgeId) || b.cfg.host === d.host) })),
    );

    let stopDiscovery = () => {};
    if (ctx.config.discovery !== false) {
      const { Bonjour } = await import('bonjour-service');
      const bonjour = new Bonjour(undefined, (err: Error) => ctx.log.debug('mDNS error', { error: err.message }));
      const browser = bonjour.find({ type: 'hue' }, (service) => {
        const host = service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? service.host;
        if (!host) return;
        const bridgeId = typeof service.txt?.bridgeid === 'string' ? service.txt.bridgeid.toLowerCase() : undefined;
        discovered.set(host, { host, name: service.name, ...(bridgeId ? { bridgeId } : {}), at: Date.now() });
        // A paired bridge that moved to a new address (DHCP): follow it.
        const moved = bridgeId ? bridges.get(bridgeId) : undefined;
        if (moved && moved.cfg.host !== host) {
          ctx.log.info('Hue bridge changed address', { from: moved.cfg.host, to: host });
          const cfg = { ...moved.cfg, host };
          saved = saved.map((s) => (keyOf(s) === bridgeId ? cfg : s));
          save();
          start(cfg);
        }
      });
      stopDiscovery = () => {
        browser.stop();
        bonjour.destroy();
      };
    }
    ctx.onStop(() => {
      stopDiscovery();
      for (const b of bridges.values()) b.run.close();
    });
  },
});
