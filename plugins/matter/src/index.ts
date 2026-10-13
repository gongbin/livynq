import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { defineAdapter, getCapability, type PluginContext, type PluginDevice } from '@livynq/sdk';
import {
  AGGREGATOR,
  BRIDGED_NODE,
  attributeToUpdates,
  commandToMatter,
  planEndpoint,
  switchEventToUpdate,
  type ClusterState,
  type EndpointPlan,
  type MatterEndpointSnapshot,
} from './mapping.ts';

/**
 * Matter controller: commission Matter devices (Wi-Fi, Thread via an existing border router,
 * or devices already in Apple/Google Home through multi-admin) and control them from Livynq.
 *
 *   plugins:
 *     - module: "@livynq/plugin-matter"
 *       config: { networkInterface: eth0 }   # optional: limit Matter discovery to one interface
 *
 *   livynq plugin action matter commission --params '{"code":"3497-011-2332"}'   # manual or "MT:…" QR code
 *   livynq plugin action matter nodes
 *   livynq plugin action matter remove --params '{"nodeId":"123"}'
 *
 * Commissioning fabric credentials live in the plugin data directory (included in backups).
 */

// Structural types for the parts of matter.js used here (kept loose: the controller API is large).
interface ClusterClient {
  id: number;
  name: string;
  attributes: Record<string, { getLocal(): unknown; set(value: unknown): Promise<void> }>;
  commands: Record<string, (request?: unknown, options?: { asTimedRequest?: boolean }) => Promise<unknown>>;
}
interface MatterEndpoint {
  number: number | undefined;
  getDeviceTypes(): { code: number }[];
  getAllClusterClients(): ClusterClient[];
  getChildEndpoints(): MatterEndpoint[];
}
interface Observable<T extends unknown[]> {
  on(fn: (...args: T) => void): void;
}
interface PairedNode {
  nodeId: bigint;
  initialized: boolean;
  connectionState: number;
  basicInformation?: { nodeLabel?: string; productName?: string; vendorName?: string; serialNumber?: string; softwareVersionString?: string; productLabel?: string };
  connect(): void;
  disconnect(): Promise<void>;
  getDevices(): MatterEndpoint[];
  events: {
    initialized: Observable<[unknown]>;
    structureChanged: Observable<[]>;
    stateChanged: Observable<[number]>;
    attributeChanged: Observable<[{ path: { endpointId: number; clusterId: number; attributeName: string }; value: unknown }]>;
    eventTriggered: Observable<[{ path: { endpointId: number; clusterId: number; eventName: string }; events: unknown[] }]>;
    decommissioned: Observable<[]>;
  };
}
export interface MatterController {
  start(): Promise<void>;
  close(): Promise<void>;
  getCommissionedNodes(): bigint[];
  getNode(nodeId: bigint): Promise<PairedNode>;
  commissionNode(options: unknown): Promise<bigint>;
  removeNode(nodeId: bigint, tryDecommissioning?: boolean): Promise<void>;
}
export interface MatterRuntime {
  createController(storagePath: string, options: { networkInterface?: string }): Promise<MatterController>;
  decodePairingCode(code: string): Promise<{ passcode: number; shortDiscriminator?: number; longDiscriminator?: number }>;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
// Node connection states: 0 connected, 1 disconnected, 2 reconnecting, 3 waiting for discovery
const CONNECTED = 0;

interface Bound {
  device: PluginDevice;
  deviceId: string;
  livynqEndpoint: number;
  matter: MatterEndpoint;
  plan: EndpointPlan;
  clusters: ClusterState;
}

export function createMatterPlugin(runtime: MatterRuntime) {
  return defineAdapter({
    async setup(ctx) {
      const storage = join(ctx.dataDir, 'controller');
      mkdirSync(storage, { recursive: true });
      const controller = await runtime.createController(storage, { networkInterface: typeof ctx.config.networkInterface === 'string' ? ctx.config.networkInterface : undefined });
      await controller.start();
      ctx.onStop(() => controller.close());

      /** "<node>/<endpoint>" → bound endpoint */
      const bound = new Map<string, Bound>();
      const nodes = new Map<string, PairedNode>();

      const attach = async (nodeId: bigint): Promise<void> => {
        const key = String(nodeId);
        if (nodes.has(key)) return;
        const node = await controller.getNode(nodeId);
        nodes.set(key, node);
        node.events.initialized.on(() => void publish(ctx, node, bound));
        node.events.structureChanged.on(() => void publish(ctx, node, bound));
        node.events.stateChanged.on((state) => {
          for (const b of bound.values()) if (b.deviceId.startsWith(`matter:${key}`)) b.device.setAvailability(state === CONNECTED ? 'online' : 'offline');
        });
        node.events.attributeChanged.on(({ path, value }) => {
          const b = bound.get(`${key}/${path.endpointId}`);
          if (!b) return;
          const client = b.matter.getAllClusterClients().find((c) => c.id === path.clusterId);
          if (!client) return;
          const cluster = lowerFirst(client.name);
          (b.clusters[cluster] ??= {})[path.attributeName] = value;
          for (const u of attributeToUpdates(b.plan, cluster, path.attributeName, value, b.clusters)) b.device.update(b.livynqEndpoint, u.capability, u.attributes);
        });
        node.events.eventTriggered.on(({ path }) => {
          const b = bound.get(`${key}/${path.endpointId}`);
          const u = b && b.plan.capabilities.includes('genericSwitch') ? switchEventToUpdate(path.eventName) : undefined;
          if (b && u) b.device.update(b.livynqEndpoint, u.capability, u.attributes);
        });
        node.events.decommissioned.on(() => void forget(key));
        node.connect();
        if (node.initialized) await publish(ctx, node, bound);
      };

      const forget = async (key: string) => {
        nodes.delete(key);
        for (const [k, b] of [...bound]) if (k.startsWith(`${key}/`)) bound.delete(k);
        for (const d of await ctx.devices.known()) if (d.id === `matter:${key}` || d.id.startsWith(`matter:${key}:`)) await ctx.devices.remove(d.id);
      };

      for (const nodeId of controller.getCommissionedNodes()) {
        attach(nodeId).catch((err: Error) => ctx.log.warn('could not restore Matter node', { nodeId: String(nodeId), error: err.message }));
      }
      ctx.log.info(`Matter controller ready (${controller.getCommissionedNodes().length} commissioned nodes)`);

      ctx.actions.register('commission', 'Add a Matter device: { code: manual pairing code or "MT:…" QR text, ip?, port? }', async (params) => {
        const code = String(params.code ?? '').trim();
        if (!code) throw new Error('code is required (11/21-digit manual code or MT:… QR payload)');
        const { passcode, shortDiscriminator, longDiscriminator } = await runtime.decodePairingCode(code);
        const identifierData = longDiscriminator !== undefined ? { longDiscriminator } : { shortDiscriminator };
        ctx.log.info('commissioning Matter device…', { identifierData });
        const nodeId = await controller.commissionNode({
          // 2 = indoor/outdoor
          commissioning: { regulatoryLocation: 2, regulatoryCountryCode: 'XX' },
          discovery: {
            identifierData,
            discoveryCapabilities: { onIpNetwork: true },
            ...(params.ip ? { knownAddress: { ip: String(params.ip), port: Number(params.port ?? 5540), type: 'udp' } } : {}),
          },
          passcode,
        });
        await attach(nodeId);
        return { nodeId: String(nodeId) };
      });
      ctx.actions.register('nodes', 'List commissioned Matter nodes', async () =>
        [...nodes.values()].map((n) => ({
          nodeId: String(n.nodeId),
          connected: n.connectionState === CONNECTED,
          name: n.basicInformation?.nodeLabel || n.basicInformation?.productName,
          vendor: n.basicInformation?.vendorName,
          devices: [...new Set([...bound.values()].filter((b) => b.deviceId.startsWith(`matter:${n.nodeId}`)).map((b) => b.deviceId))],
        })),
      );
      ctx.actions.register('remove', 'Decommission a Matter node: { nodeId }', async (params) => {
        const key = String(params.nodeId ?? '');
        const node = nodes.get(key);
        if (!node) throw new Error(`Unknown node ${key}`);
        await controller.removeNode(node.nodeId, true);
        await forget(key);
        return { removed: key };
      });
    },
  });
}

/** Builds Livynq devices from a node's endpoint tree. Bridged nodes become one device each. */
async function publish(ctx: PluginContext, node: PairedNode, bound: Map<string, Bound>): Promise<void> {
  const key = String(node.nodeId);
  const groups = new Map<string, { name: string; endpoints: { matter: MatterEndpoint; snapshot: MatterEndpointSnapshot; plan: EndpointPlan }[] }>();
  const nodeName = node.basicInformation?.nodeLabel || node.basicInformation?.productName || `Matter ${key}`;

  const visit = (ep: MatterEndpoint, group: string, groupName: string) => {
    const types = ep.getDeviceTypes().map((t) => t.code);
    const clusters: ClusterState = {};
    for (const client of ep.getAllClusterClients()) {
      const attrs: Record<string, unknown> = {};
      for (const [name, attr] of Object.entries(client.attributes)) {
        try {
          const v = attr.getLocal();
          if (v !== undefined) attrs[name] = v;
        } catch {
          // attribute not readable
        }
      }
      clusters[lowerFirst(client.name)] = attrs;
    }
    let targetGroup = group;
    let targetName = groupName;
    if (types.includes(BRIDGED_NODE) && ep.number !== undefined) {
      targetGroup = `matter:${key}:${ep.number}`;
      const info = clusters.bridgedDeviceBasicInformation ?? {};
      targetName = String(info.nodeLabel || info.productName || `${nodeName} ${ep.number}`);
    }
    const snapshot: MatterEndpointSnapshot = { number: ep.number ?? 0, deviceTypes: types, clusters };
    const plan = types.includes(AGGREGATOR) ? undefined : planEndpoint(snapshot);
    if (plan) {
      const g = groups.get(targetGroup) ?? { name: targetName, endpoints: [] };
      g.endpoints.push({ matter: ep, snapshot, plan });
      groups.set(targetGroup, g);
    }
    for (const child of ep.getChildEndpoints()) visit(child, types.includes(AGGREGATOR) ? `matter:${key}` : targetGroup, targetName);
  };
  for (const ep of node.getDevices()) visit(ep, `matter:${key}`, nodeName);

  for (const [deviceId, g] of groups) {
    const endpoints = [];
    for (const e of g.endpoints) endpoints.push({ ...e, livynqEndpoint: await ctx.endpointId(deviceId, `ep${e.snapshot.number}`) });
    const multi = endpoints.length > 1;
    const device = await ctx.devices.upsert({
      id: deviceId,
      name: g.name,
      protocol: 'matter',
      info: { manufacturer: node.basicInformation?.vendorName, model: node.basicInformation?.productName, serial: node.basicInformation?.serialNumber, firmware: node.basicInformation?.softwareVersionString },
      endpoints: endpoints.map((e) => ({ id: e.livynqEndpoint, deviceType: e.plan.deviceType, capabilities: e.plan.capabilities, ...(multi ? { name: `Endpoint ${e.snapshot.number}` } : {}) })),
    });
    for (const e of endpoints) {
      const b: Bound = { device, deviceId, livynqEndpoint: e.livynqEndpoint, matter: e.matter, plan: e.plan, clusters: e.snapshot.clusters };
      bound.set(`${key}/${e.snapshot.number}`, b);
      for (const [cluster, attrs] of Object.entries(b.clusters)) {
        for (const [attribute, value] of Object.entries(attrs)) {
          for (const u of attributeToUpdates(b.plan, cluster, attribute, value, b.clusters)) device.update(b.livynqEndpoint, u.capability, u.attributes);
        }
      }
      for (const capability of b.plan.capabilities) {
        const commands = Object.keys(getCapability(capability)?.commands ?? {});
        if (!commands.length) continue;
        device.handle(
          b.livynqEndpoint,
          capability,
          Object.fromEntries(
            commands.map((command) => [
              command,
              async (params: Record<string, unknown>) => {
                for (const action of commandToMatter(capability, command, params, b.clusters)) {
                  const client = b.matter.getAllClusterClients().find((c) => lowerFirst(c.name) === action.cluster);
                  if (!client) throw new Error(`Matter cluster ${action.cluster} not available`);
                  if (action.kind === 'write') await client.attributes[action.attribute]!.set(action.value);
                  else await client.commands[action.command]!(action.request, action.timed ? { asTimedRequest: true } : undefined);
                }
              },
            ]),
          ),
        );
      }
    }
    device.setAvailability(node.connectionState === CONNECTED || node.initialized ? 'online' : 'offline');
  }
  ctx.log.info(`Matter node ${key}: ${groups.size} device(s)`);
}

export default createMatterPlugin({
  async createController(storagePath, options) {
    const { Environment } = await import('@matter/main');
    const { CommissioningController } = await import('@project-chip/matter.js');
    const environment = Environment.default;
    environment.vars.set('storage.path', storagePath);
    // Hosts with VPN/tunnel interfaces: restrict discovery to the LAN interface (e.g. "eth0", "en0").
    const networkInterface = options.networkInterface ?? process.env.MATTER_MDNS_NETWORKINTERFACE ?? defaultMatterInterface();
    if (networkInterface) environment.vars.set('mdns.networkInterface', networkInterface);
    return new CommissioningController({
      environment: { environment, id: 'livynq-controller' },
      autoConnect: false,
      adminFabricLabel: 'Livynq',
    }) as unknown as MatterController;
  },
  async decodePairingCode(code) {
    const { QrPairingCodeCodec, ManualPairingCodeCodec } = await import('@matter/main/types');
    if (code.startsWith('MT:')) {
      const qr = QrPairingCodeCodec.decode(code)[0]!;
      return { passcode: qr.passcode, longDiscriminator: qr.discriminator };
    }
    const manual = ManualPairingCodeCodec.decode(code.replace(/\D/g, ''));
    return { passcode: manual.passcode, shortDiscriminator: manual.shortDiscriminator };
  },
});

/**
 * Matter mDNS on every interface makes controllers try VPN/tunnel link-local addresses first
 * (seen on macOS with utun*). Default to the primary LAN interface unless configured.
 */
export function defaultMatterInterface(): string | undefined {
  const skip = /^(lo|utun|awdl|llw|bridge|docker|veth|br-|virbr|vmnet|tun|tap|wg|zt|tailscale|ham)/i;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue;
    if (addrs?.some((a) => a.family === 'IPv4' && !a.internal)) return name;
  }
  return undefined;
}
