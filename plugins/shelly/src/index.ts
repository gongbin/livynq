import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineAdapter, type PluginContext, type PluginDevice } from '@livynq/sdk';
import { commandToRpc, componentCommands, eventToUpdate, planComponents, statusToUpdates, type ComponentPlan } from './mapping.ts';
import { RpcError, ShellyConnection } from './rpc.ts';

/**
 * Shelly Gen2+ (Plus, Pro, Gen3, Gen4, Wave Pro excluded) over the local WebSocket RPC API.
 *
 *   plugins:
 *     - module: "@livynq/plugin-shelly"
 *       config:
 *         discovery: true            # find devices via mDNS (_shelly._tcp) and add them
 *         password: "…"              # default password for devices with authentication enabled
 *         devices:
 *           - host: 192.168.1.50
 *             password: "…"
 *
 * Battery devices (H&T, door/window) sleep and are not reachable this way yet.
 */

interface HostConfig {
  host: string;
  password?: string;
}

interface DeviceInfo {
  id: string;
  mac: string;
  model?: string;
  gen?: number;
  app?: string;
  ver?: string;
  name?: string | null;
}

type Status = Record<string, Record<string, unknown>>;

function runHost(ctx: PluginContext, cfg: HostConfig, src: string): { close(): void; connection: ShellyConnection } {
  const conn = new ShellyConnection({ host: cfg.host, password: cfg.password, src });
  let device: PluginDevice | undefined;
  let plans: { plan: ComponentPlan; endpointId: number }[] = [];

  const apply = (status: Record<string, unknown>) => {
    if (!device) return;
    for (const b of plans) {
      const s = status[b.plan.key];
      if (s && typeof s === 'object') for (const u of statusToUpdates(b.plan, s as Record<string, unknown>)) device.update(b.endpointId, u.capability, u.attributes);
    }
  };

  const publish = async () => {
    const info = await conn.call<DeviceInfo>('Shelly.GetDeviceInfo');
    const [config, status] = await Promise.all([conn.call<Record<string, { name?: string | null; type?: string }>>('Shelly.GetConfig'), conn.call<Status>('Shelly.GetStatus')]);
    const id = `shelly:${info.mac.toLowerCase()}`;
    const planned = planComponents(status, config);
    if (!planned.length) return ctx.log.info(`${cfg.host}: no supported components`, { model: info.model });
    plans = await Promise.all(planned.map(async (plan) => ({ plan, endpointId: await ctx.endpointId(id, plan.key) })));
    plans.sort((a, b) => a.endpointId - b.endpointId);
    const sysName = (config.sys as { device?: { name?: string | null } } | undefined)?.device?.name;
    device = await ctx.devices.upsert({
      id,
      name: info.name || sysName || info.app || info.id,
      protocol: 'shelly',
      info: { manufacturer: 'Shelly', model: info.model ?? info.app, firmware: info.ver, serial: info.mac },
      endpoints: plans.map((b) => ({
        id: b.endpointId,
        deviceType: b.plan.deviceType,
        capabilities: b.plan.capabilities,
        ...(plans.length > 1 ? { name: b.plan.name ?? `${b.plan.type[0]!.toUpperCase()}${b.plan.type.slice(1)} ${b.plan.id + 1}` } : {}),
      })),
    });
    const dev = device;
    for (const b of plans) {
      for (const [capability, commands] of Object.entries(componentCommands(b.plan))) {
        dev.handle(
          b.endpointId,
          capability,
          Object.fromEntries(
            commands.map((command) => [
              command,
              async (params: Record<string, unknown>) => {
                const rpc = commandToRpc(b.plan, capability, command, params);
                await conn.call(rpc.method, rpc.params);
              },
            ]),
          ),
        );
      }
    }
    apply(status);
    dev.setAvailability('online');
    ctx.log.info(`${cfg.host}: connected (${info.model ?? info.app})`, { id, components: plans.length });
  };

  conn.on('open', () => {
    void publish().catch((err: Error) => {
      if (err instanceof RpcError && err.code === 401) ctx.log.warn(`${cfg.host}: ${err.message} — set the device password in the Shelly plugin`);
      else ctx.log.error(`${cfg.host}: failed to read the device`, { error: err.message });
    });
  });
  conn.on('notify', (method: string, params: Record<string, unknown>) => {
    if (method === 'NotifyStatus' || method === 'NotifyFullStatus') apply(params);
    else if (method === 'NotifyEvent' && device) {
      for (const e of (params.events ?? []) as { component?: string; event?: string }[]) {
        const b = plans.find((p) => p.plan.key === e.component && p.plan.type === 'input');
        const u = b && e.event ? eventToUpdate(e.event) : undefined;
        if (b && u) device.update(b.endpointId, u.capability, u.attributes);
      }
    }
  });
  conn.on('close', () => device?.setAvailability('offline'));
  conn.on('error', (err: Error) => ctx.log.debug(err.message));
  conn.connect();
  return { close: () => conn.close(), connection: conn };
}

/** Gen1 devices have no RPC API; tell the user instead of failing silently. */
async function probe(host: string): Promise<{ gen: number; model?: string }> {
  const res = await fetch(`http://${host}/shelly`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!res?.ok) throw new Error(`No Shelly device answers at ${host}`);
  const body = (await res.json()) as { gen?: number; model?: string; type?: string };
  return { gen: body.gen ?? 1, model: body.model ?? body.type };
}

export default defineAdapter({
  async setup(ctx) {
    const defaultPassword = typeof ctx.config.password === 'string' ? ctx.config.password : undefined;
    const configured = (Array.isArray(ctx.config.devices) ? ctx.config.devices : []) as HostConfig[];
    const savedFile = join(ctx.dataDir, 'hosts.json');
    let saved: HostConfig[] = [];
    try {
      saved = JSON.parse(readFileSync(savedFile, 'utf8')) as HostConfig[];
    } catch {
      // none yet
    }
    const save = () => writeFileSync(savedFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
    const src = `livynq-${randomBytes(4).toString('hex')}`;
    const hosts = new Map<string, { close(): void }>();
    const discovered = new Map<string, { host: string; name: string; model?: string; at: number }>();

    const add = (cfg: HostConfig) => {
      const key = cfg.host.toLowerCase();
      hosts.get(key)?.close();
      hosts.set(key, runHost(ctx, { password: defaultPassword, ...cfg }, src));
    };
    for (const cfg of [...configured, ...saved]) if (cfg?.host) add(cfg);

    ctx.actions.register('add', 'Connect a Shelly Gen2+ device: { host, password? }', async (p) => {
      const host = String(p.host ?? '').trim();
      if (!host) throw new Error('host is required (e.g. 192.168.1.50)');
      const found = await probe(host);
      if (found.gen < 2) throw new Error(`${host} is a first-generation Shelly (${found.model ?? 'Gen1'}); only Gen2 and newer (Plus, Pro, Gen3, Gen4) are supported`);
      const cfg: HostConfig = { host, ...(p.password ? { password: String(p.password) } : {}) };
      saved = [...saved.filter((s) => s.host.toLowerCase() !== host.toLowerCase()), cfg];
      save();
      add(cfg);
      return { added: host, model: found.model };
    });
    ctx.actions.register('remove', 'Disconnect a Shelly device added from the UI: { host }', (p) => {
      const host = String(p.host ?? '').toLowerCase();
      saved = saved.filter((s) => s.host.toLowerCase() !== host);
      save();
      hosts.get(host)?.close();
      hosts.delete(host);
      return { removed: host };
    });
    ctx.actions.register('discovered', 'Shelly devices found on the network via mDNS', () =>
      [...discovered.values()].map((d) => ({ ...d, connected: hosts.has(d.host.toLowerCase()) })),
    );

    let stopDiscovery = () => {};
    if (ctx.config.discovery !== false) {
      const { Bonjour } = await import('bonjour-service');
      const bonjour = new Bonjour(undefined, (err: Error) => ctx.log.debug('mDNS error', { error: err.message }));
      const browser = bonjour.find({ type: 'shelly' }, (service) => {
        const host = service.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? service.host;
        if (!host) return;
        discovered.set(host, { host, name: service.name, model: service.txt?.app as string | undefined, at: Date.now() });
        if (ctx.config.autoAdd === false || hosts.has(host.toLowerCase())) return;
        ctx.log.info('discovered Shelly device', { host, name: service.name });
        add({ host });
      });
      stopDiscovery = () => {
        browser.stop();
        bonjour.destroy();
      };
    }
    ctx.onStop(() => {
      stopDiscovery();
      for (const h of hosts.values()) h.close();
    });
  },
});
