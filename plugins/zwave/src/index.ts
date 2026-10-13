import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineAdapter, type PluginContext, type PluginDevice } from '@livynq/sdk';
import { commandToWrites, featureCommands, planFeatures, sceneToUpdate, valueToUpdates, CC, type Feature, type ValueId } from './mapping.ts';

/**
 * Z-Wave via zwave-js (S0/S2, SmartStart, Long Range).
 *
 *   plugins:
 *     - module: "@livynq/plugin-zwave"
 *       config:
 *         port: /dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick-if00   # or tcp://host:port (ser2net)
 *
 * Network security keys are generated on first start and kept in the plugin's data directory
 * (keys.json, mode 0600) — back them up: without them secure devices must be re-included.
 */

interface ZNode {
  id: number;
  ready: boolean;
  status: number;
  name?: string;
  label?: string;
  manufacturer?: string;
  firmwareVersion?: string;
  deviceClass?: { generic: { key: number }; specific: { key: number } };
  getDefinedValueIDs(): ValueId[];
  getValue(v: ValueId): unknown;
  getValueMetadata(v: ValueId): { unit?: string; ccSpecific?: Record<string, unknown> };
  setValue(v: ValueId, value: unknown): Promise<{ status: number; message?: string }>;
  on(event: string, fn: (...args: never[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
}

const KEY_NAMES = ['S2_AccessControl', 'S2_Authenticated', 'S2_Unauthenticated', 'S0_Legacy', 'LR_S2_AccessControl', 'LR_S2_Authenticated'] as const;

function loadKeys(dir: string): Record<(typeof KEY_NAMES)[number], Uint8Array<ArrayBuffer>> {
  const file = join(dir, 'keys.json');
  let stored: Record<string, string> = {};
  try {
    stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    // first start
  }
  let changed = false;
  for (const k of KEY_NAMES) {
    if (!/^[0-9a-f]{32}$/i.test(stored[k] ?? '')) {
      stored[k] = randomBytes(16).toString('hex');
      changed = true;
    }
  }
  if (changed) writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return Object.fromEntries(KEY_NAMES.map((k) => [k, new Uint8Array(Buffer.from(stored[k]!, 'hex'))])) as Record<(typeof KEY_NAMES)[number], Uint8Array<ArrayBuffer>>;
}

const NODE_DEAD = 3;
const SET_VALUE_FAILED = [0, 2, 3, 4, 5];

export default defineAdapter({
  async setup(ctx: PluginContext) {
    const port = typeof ctx.config.port === 'string' ? ctx.config.port.trim() : '';
    if (!port) throw new Error('Set "port" to the Z-Wave stick (e.g. /dev/serial/by-id/…) or tcp://host:port');
    const { Driver, InclusionStrategy, ExclusionStrategy, parseQRCodeString } = await import('zwave-js');
    mkdirSync(join(ctx.dataDir, 'cache'), { recursive: true });
    const keys = loadKeys(ctx.dataDir);

    // S2 inclusion: grant what the device asks for; a PIN (from the device label) comes in via the "pin" action.
    let pending: { dsk: string; resolve: (pin: string | false) => void } | undefined;
    let lastIncluded: { nodeId: number; at: number; lowSecurity?: boolean } | undefined;
    let lastRemoved: { nodeId: number; at: number } | undefined;
    const userCallbacks = {
      grantSecurityClasses: async (requested: { securityClasses: number[]; clientSideAuth: boolean }) => requested,
      validateDSKAndEnterPIN: (dsk: string) =>
        new Promise<string | false>((resolve) => {
          pending = { dsk, resolve };
        }),
      abort: () => {
        pending?.resolve(false);
        pending = undefined;
      },
    };

    const driver = new Driver(port, {
      logConfig: { enabled: process.env.LIVYNQ_ZWAVE_LOG === '1', level: 'info' },
      storage: { cacheDir: join(ctx.dataDir, 'cache') },
      securityKeys: { S2_AccessControl: keys.S2_AccessControl, S2_Authenticated: keys.S2_Authenticated, S2_Unauthenticated: keys.S2_Unauthenticated, S0_Legacy: keys.S0_Legacy },
      securityKeysLongRange: { S2_AccessControl: keys.LR_S2_AccessControl, S2_Authenticated: keys.LR_S2_Authenticated },
      inclusionUserCallbacks: userCallbacks,
      // No usage statistics are sent unless enableStatistics() is called.
    });
    driver.on('error', (err: Error) => ctx.log.error('Z-Wave driver error', { error: err.message }));

    let homeId = '';
    const devices = new Map<number, { device: PluginDevice; features: { feature: Feature; endpointId: number }[] }>();
    const deviceId = (nodeId: number) => `zwave:${homeId}-${nodeId}`;

    const publish = async (node: ZNode) => {
      const values = node.getDefinedValueIDs();
      const features = planFeatures({
        generic: node.deviceClass?.generic.key,
        specific: node.deviceClass?.specific.key,
        values,
        // Electric meter (type 1), scale 2 = W
        isPowerMeter: (v) => {
          const s = node.getValueMetadata(v).ccSpecific;
          return s?.meterType === 1 && s?.scale === 2;
        },
      });
      if (!features.length) return ctx.log.info(`node ${node.id}: no supported functions`, { label: node.label });
      const id = deviceId(node.id);
      const bound = await Promise.all(features.map(async (feature) => ({ feature, endpointId: await ctx.endpointId(id, feature.key) })));
      bound.sort((a, b) => a.endpointId - b.endpointId);
      const device = await ctx.devices.upsert({
        id,
        name: node.name || [node.manufacturer, node.label].filter(Boolean).join(' ') || `Z-Wave node ${node.id}`,
        protocol: 'zwave',
        info: { manufacturer: node.manufacturer, model: node.label, firmware: node.firmwareVersion, serial: `${homeId}-${node.id}` },
        endpoints: bound.map((b) => ({ id: b.endpointId, deviceType: b.feature.deviceType, capabilities: b.feature.capabilities, ...(bound.length > 1 ? { name: b.feature.name } : {}) })),
      });
      devices.set(node.id, { device, features: bound });

      const apply = (valueId: ValueId, value: unknown) => {
        if (value === undefined) return;
        const unit = node.getValueMetadata(valueId).unit;
        for (const b of bound) for (const u of valueToUpdates(b.feature, valueId, value, unit)) device.update(b.endpointId, u.capability, u.attributes);
      };
      for (const b of bound) for (const v of Object.values(b.feature.values)) apply(v, node.getValue(v));

      for (const b of bound) {
        for (const [capability, commands] of Object.entries(featureCommands(b.feature))) {
          device.handle(
            b.endpointId,
            capability,
            Object.fromEntries(
              commands.map((command) => [
                command,
                async (params: Record<string, unknown>) => {
                  const state = { on: device.get(b.endpointId, 'onOff', 'onOff') === true, supportedModes: device.get(b.endpointId, 'thermostat', 'systemMode') === 'cool' ? 'cool' : undefined };
                  for (const w of commandToWrites(b.feature, capability, command, params, state)) {
                    const result = await node.setValue(w.valueId, w.value);
                    if (SET_VALUE_FAILED.includes(result.status)) throw new Error(result.message || `Z-Wave node ${node.id} rejected the command (status ${result.status})`);
                  }
                },
              ]),
            ),
          );
        }
      }
      device.setAvailability(node.status === NODE_DEAD ? 'offline' : 'online');
      ctx.log.info(`node ${node.id} ready: ${bound.length} functions`, { id, label: node.label });
    };

    const attach = (node: ZNode) => {
      if (node.id === driver.controller.ownNodeId) return;
      const update = (_n: unknown, args: ValueId & { newValue: unknown }) => {
        const d = devices.get(node.id);
        if (!d) return;
        const unit = node.getValueMetadata(args).unit;
        for (const b of d.features) for (const u of valueToUpdates(b.feature, args, args.newValue, unit)) d.device.update(b.endpointId, u.capability, u.attributes);
      };
      node.on('value updated', update as never);
      node.on('value added', update as never);
      node.on('value notification', ((_n: unknown, args: ValueId & { value: unknown }) => {
        const d = devices.get(node.id);
        const scene = d?.features.find((b) => b.feature.kind === 'scene');
        if (!d || !scene || args.commandClass !== CC.CentralScene || typeof args.value !== 'number') return;
        const u = sceneToUpdate(args.propertyKey ?? '', args.value);
        if (u) d.device.update(scene.endpointId, u.capability, u.attributes);
      }) as never);
      node.on('dead', (() => devices.get(node.id)?.device.setAvailability('offline')) as never);
      node.on('alive', (() => devices.get(node.id)?.device.setAvailability('online')) as never);
      const ready = () => void publish(node).catch((err: Error) => ctx.log.error(`node ${node.id}: failed to publish`, { error: err.message }));
      node.on('ready', ready as never);
      if (node.ready) ready();
    };

    driver.once('driver ready', () => {
      homeId = (driver.controller.homeId ?? 0).toString(16).padStart(8, '0');
      ctx.log.info('Z-Wave controller ready', { homeId, nodes: driver.controller.nodes.size - 1 });
      for (const node of driver.controller.nodes.values()) attach(node as unknown as ZNode);
      driver.controller.on('node added', (node, result) => {
        lastIncluded = { nodeId: node.id, at: Date.now(), ...(result.lowSecurity ? { lowSecurity: true } : {}) };
        ctx.log.info(`node ${node.id} included`, result.lowSecurity ? { warning: 'secure inclusion failed; the device works without encryption' } : {});
        attach(node as unknown as ZNode);
      });
      driver.controller.on('node removed', (node) => {
        lastRemoved = { nodeId: node.id, at: Date.now() };
        const d = devices.get(node.id);
        devices.delete(node.id);
        if (d) void ctx.devices.remove(d.device.id);
      });
    });

    await driver.start();
    ctx.onStop(async () => {
      userCallbacks.abort();
      await driver.destroy();
    });

    const ctrl = () => {
      if (!homeId) throw new Error('The Z-Wave controller is still starting');
      return driver.controller;
    };
    ctx.actions.register('include', 'Add a device: put it in pairing mode after starting. S2 devices then ask for the 5-digit PIN from their label (action "pin").', async () => {
      lastIncluded = undefined;
      const started = await ctrl().beginInclusion({ strategy: InclusionStrategy.Default, userCallbacks });
      return { started, note: started ? 'Inclusion running (about 60 s). Press the pairing button on the device.' : 'Inclusion or exclusion is already running' };
    });
    ctx.actions.register('pin', 'Enter the 5-digit PIN for the device being added (S2): { pin }', (p) => {
      if (!pending) throw new Error('No device is waiting for a PIN');
      const pin = String(p.pin ?? '').trim();
      if (!/^\d{5}$/.test(pin)) throw new Error('The PIN is the first 5 digits of the DSK on the device label');
      pending.resolve(pin);
      pending = undefined;
      return { ok: true };
    });
    ctx.actions.register('exclude', 'Remove (reset) a device: start, then press the pairing button on the device', async () => {
      lastRemoved = undefined;
      return { started: await ctrl().beginExclusion({ strategy: ExclusionStrategy.Unprovision }) };
    });
    ctx.actions.register('stop', 'Stop inclusion / exclusion', async () => {
      userCallbacks.abort();
      const c = ctrl();
      return { stopped: (await c.stopInclusion()) || (await c.stopExclusion()) };
    });
    ctx.actions.register('status', 'Controller state, a pending S2 PIN request and the last included node', () => {
      const c = ctrl();
      return {
        homeId,
        inclusionState: ['idle', 'including', 'excluding', 'busy', 'smartStart'][c.inclusionState] ?? String(c.inclusionState),
        nodes: c.nodes.size - 1,
        ...(pending ? { pinRequired: true, dsk: pending.dsk } : {}),
        ...(lastIncluded ? { lastIncluded: { ...lastIncluded, deviceId: deviceId(lastIncluded.nodeId) } } : {}),
        ...(lastRemoved ? { lastRemoved } : {}),
      };
    });
    ctx.actions.register('provision', 'SmartStart: add a device by its QR code ("90…" string); it joins as soon as it is powered', async (p) => {
      const info = await parseQRCodeString(String(p.qr ?? '').trim());
      ctrl().provisionSmartStartNode(info as never);
      return { dsk: info.dsk, note: 'Power the device on near the hub; it is added automatically.' };
    });
    ctx.actions.register('nodes', 'Nodes in the Z-Wave network', () =>
      [...ctrl().nodes.values()]
        .filter((n) => n.id !== ctrl().ownNodeId)
        .map((n) => ({ nodeId: n.id, deviceId: deviceId(n.id), label: n.label, manufacturer: n.manufacturer, ready: n.ready, status: ['unknown', 'asleep', 'awake', 'dead', 'alive'][n.status] })),
    );
  },
});
