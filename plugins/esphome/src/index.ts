import type { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { defineAdapter, type PluginContext, type PluginDefinition, type PluginDevice } from '@livynq/sdk';
import { commandPayload, entityCommands, planEntity, stateToUpdates, type EndpointPlan, type EsphomeEntityConfig } from './mapping.ts';

/**
 * ESPHome native API adapter.
 *
 *   plugins:
 *     - module: "@livynq/plugin-esphome"
 *       config:
 *         discovery: true                   # find devices via mDNS (_esphomelib._tcp)
 *         encryptionKey: "base64…"          # default key for discovered devices (api: encryption: key)
 *         devices:
 *           - host: kitchen.local
 *             encryptionKey: "base64…"
 */

export interface EsphomeEntity extends EventEmitter {
  type: string;
  config: EsphomeEntityConfig;
  state?: Record<string, unknown>;
  command(data: Record<string, unknown>): void;
}

export interface EsphomeClient extends EventEmitter {
  connect(): void;
  disconnect(): void;
}

export interface DeviceInfo {
  name: string;
  friendlyName?: string;
  macAddress: string;
  model?: string;
  manufacturer?: string;
  esphomeVersion?: string;
  suggestedArea?: string;
}

export type ClientFactory = (options: { host: string; port: number; encryptionKey?: string; password?: string }) => EsphomeClient;
export type DiscoveryFactory = () => EventEmitter & { run(): void; destroy?(): void };

interface DeviceConfig {
  host: string;
  port?: number;
  encryptionKey?: string;
  password?: string;
}

interface Bound {
  type: string;
  config: EsphomeEntityConfig;
  plan: EndpointPlan;
  endpointId: number;
  entity: EsphomeEntity;
}

/** One connection per ESPHome node; entities are collected until the API finishes listing them. */
async function runNode(ctx: PluginContext, createClient: ClientFactory, cfg: DeviceConfig): Promise<() => void> {
  const client = createClient({ host: cfg.host, port: cfg.port ?? 6053, encryptionKey: cfg.encryptionKey, password: cfg.password });
  let info: DeviceInfo | undefined;
  let device: PluginDevice | undefined;
  let entities: EsphomeEntity[] = [];
  const log = (message: string, data: Record<string, unknown> = {}) => ctx.log.info(message, { host: cfg.host, ...data });

  client.on('deviceInfo', (i: DeviceInfo) => {
    info = i;
    entities = [];
  });
  client.on('newEntity', (entity: EsphomeEntity) => entities.push(entity));
  client.on('initialized', () => {
    void publish().catch((err: Error) => ctx.log.error('failed to publish ESPHome device', { host: cfg.host, error: err.message }));
  });
  client.on('disconnected', () => device?.setAvailability('offline'));
  client.on('error', (err: Error) => {
    const message = err?.message ?? String(err);
    if (/encrypt|noise|handshake/i.test(message)) ctx.log.warn(`${cfg.host}: encryption problem — set the device's api encryption key in the plugin config`, { error: message });
    else ctx.log.debug('ESPHome connection error', { host: cfg.host, error: message });
  });

  async function publish(): Promise<void> {
    if (!info) return;
    const mac = info.macAddress.replace(/[^0-9a-f]/gi, '').toLowerCase();
    const id = `esphome:${mac}`;
    const bound: Bound[] = [];
    for (const entity of entities) {
      const plan = planEntity(entity.type, entity.config);
      if (!plan) continue;
      // object_id is stable across reflashes; ESPHome keys are hashes that may change.
      bound.push({ type: entity.type, config: entity.config, plan, entity, endpointId: await ctx.endpointId(id, entity.config.objectId) });
    }
    if (!bound.length) return log('no supported entities on this node');
    device = await ctx.devices.upsert({
      id,
      name: info.friendlyName || info.name,
      protocol: 'esphome',
      suggestedRoom: info.suggestedArea || undefined,
      info: { manufacturer: info.manufacturer || 'ESPHome', model: info.model, firmware: info.esphomeVersion, serial: mac },
      endpoints: bound
        .sort((a, b) => a.endpointId - b.endpointId)
        .map((b) => ({ id: b.endpointId, deviceType: b.plan.deviceType, capabilities: b.plan.capabilities, ...(bound.length > 1 ? { name: b.config.name } : {}) })),
    });
    const dev = device;
    for (const b of bound) {
      const apply = (state: Record<string, unknown>) => {
        for (const u of stateToUpdates(b.type, b.plan, b.config, state)) dev.update(b.endpointId, u.capability, u.attributes);
      };
      b.entity.on('state', apply);
      if (b.entity.state) apply(b.entity.state);
      for (const [capability, commands] of Object.entries(entityCommands(b.type, b.plan, b.config))) {
        dev.handle(
          b.endpointId,
          capability,
          Object.fromEntries(
            commands.map((command) => [
              command,
              (params: Record<string, unknown>) => b.entity.command(commandPayload(b.type, capability, command, params, { on: dev.get(b.endpointId, 'onOff', 'onOff') === true }, b.config)),
            ]),
          ),
        );
      }
    }
    dev.setAvailability('online');
    log(`connected: ${bound.length} entities`, { id });
  }

  client.connect();
  return () => client.disconnect();
}

export function createEsphomePlugin(factories: { createClient: ClientFactory; createDiscovery?: DiscoveryFactory }): PluginDefinition {
  return defineAdapter({
    async setup(ctx) {
      const configured = (Array.isArray(ctx.config.devices) ? ctx.config.devices : []) as DeviceConfig[];
      const defaultKey = typeof ctx.config.encryptionKey === 'string' ? ctx.config.encryptionKey : undefined;
      // Nodes added from the UI ("Add device") are remembered here.
      const savedFile = join(ctx.dataDir, 'hosts.json');
      let saved: DeviceConfig[] = [];
      try {
        saved = JSON.parse(readFileSync(savedFile, 'utf8')) as DeviceConfig[];
      } catch {
        // none yet
      }
      const hosts = new Map<string, () => void>();
      const discovered = new Map<string, { host: string; address?: string; port?: number; at: number }>();
      const closers: (() => void)[] = [];
      const add = async (cfg: DeviceConfig) => {
        const key = cfg.host.toLowerCase();
        if (hosts.has(key)) return;
        hosts.set(key, () => {});
        hosts.set(key, await runNode(ctx, factories.createClient, { encryptionKey: defaultKey, ...cfg }));
      };
      for (const cfg of [...configured, ...saved]) if (cfg?.host) await add(cfg);
      closers.push(() => hosts.forEach((close) => close()));

      ctx.actions.register('add', 'Connect an ESPHome node: { host, port?, encryptionKey? }', async (p) => {
        const host = String(p.host ?? '').trim();
        if (!host) throw new Error('host is required (e.g. kitchen.local or 192.168.1.40)');
        const cfg: DeviceConfig = { host, ...(p.port ? { port: Number(p.port) } : {}), ...(p.encryptionKey ? { encryptionKey: String(p.encryptionKey) } : {}) };
        saved = [...saved.filter((s) => s.host.toLowerCase() !== host.toLowerCase()), cfg];
        writeFileSync(savedFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
        hosts.get(host.toLowerCase())?.();
        hosts.delete(host.toLowerCase());
        await add(cfg);
        return { added: host, note: 'The device appears once it connects (wrong encryption keys are reported in the log).' };
      });
      ctx.actions.register('remove', 'Disconnect an ESPHome node added from the UI: { host }', async (p) => {
        const host = String(p.host ?? '').toLowerCase();
        saved = saved.filter((s) => s.host.toLowerCase() !== host);
        writeFileSync(savedFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
        hosts.get(host)?.();
        hosts.delete(host);
        return { removed: host };
      });
      ctx.actions.register('discovered', 'ESPHome nodes found on the network via mDNS', () =>
        [...discovered.values()].map((d) => ({ ...d, connected: hosts.has(d.host.toLowerCase()) || (d.address !== undefined && hosts.has(d.address.toLowerCase())) })),
      );

      if (ctx.config.discovery !== false && factories.createDiscovery) {
        const discovery = factories.createDiscovery();
        discovery.on('info', (found: { host?: string; address?: string; port?: number }) => {
          if (found.host || found.address) discovered.set(String(found.host ?? found.address), { host: String(found.host ?? found.address), address: found.address, port: found.port, at: Date.now() });
          if (ctx.config.autoAdd === false) return;
          const host = found.address ?? found.host;
          if (!host || hosts.has(host.toLowerCase()) || (found.host && hosts.has(found.host.toLowerCase()))) return;
          if (found.host) hosts.set(found.host.toLowerCase(), () => {});
          ctx.log.info('discovered ESPHome node', { host: found.host, address: found.address });
          void add({ host, port: found.port });
        });
        discovery.run();
        closers.push(() => discovery.destroy?.());
      }
      ctx.onStop(() => closers.forEach((close) => close()));
    },
  });
}

// The library is CommonJS.
const require = createRequire(import.meta.url);

export default createEsphomePlugin({
  createClient: (options) => {
    const { Client } = require('@2colors/esphome-native-api') as { Client: new (o: Record<string, unknown>) => EsphomeClient };
    return new Client({ ...options, reconnect: true, reconnectInterval: 15_000, initializeSubscribeLogs: false });
  },
  createDiscovery: () => {
    const { Discovery } = require('@2colors/esphome-native-api') as { Discovery: new () => EventEmitter & { run(): void; destroy?(): void } };
    return new Discovery();
  },
});
