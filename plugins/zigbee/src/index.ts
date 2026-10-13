import { randomBytes, randomInt } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { defineAdapter, type PluginContext, type PluginDefinition } from '@livynq/sdk';
import { ZigbeeBridge, type Converters, type ZhController } from './bridge.ts';

/**
 * Built-in Zigbee: drives a USB/network coordinator directly with zigbee-herdsman and uses
 * zigbee-herdsman-converters (the Zigbee2MQTT device database).
 *
 *   plugins:
 *     - module: "@livynq/plugin-zigbee"
 *       config:
 *         serialPort: /dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus-if00-port0   # or tcp://192.168.1.20:6638
 *         adapter: ember            # zstack | ember | deconz | zigate | zboss (optional: auto-detect)
 *         channel: 11               # only used when creating a new network
 *         takeOverZigbee2mqtt: /opt/zigbee2mqtt/data   # optional, first start only: keep pairings
 *
 * Stop Zigbee2MQTT before taking over its coordinator: only one program may drive it.
 */
export interface NetworkSettings {
  panID: number;
  extendedPanID: number[];
  networkKey: number[];
  channel: number;
}

export function loadOrCreateNetwork(dataDir: string, channel: number): NetworkSettings {
  const file = join(dataDir, 'network.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as NetworkSettings;
  const network: NetworkSettings = {
    panID: randomInt(1, 0xfff0),
    extendedPanID: [...randomBytes(8)],
    networkKey: [...randomBytes(16)],
    channel,
  };
  writeFileSync(file, JSON.stringify(network, null, 2), { mode: 0o600 });
  return network;
}

/**
 * Copies Zigbee2MQTT's herdsman database and coordinator backup and adopts its network
 * parameters, so already-paired devices keep working. Returns friendly names by IEEE address.
 */
export function takeOverZigbee2mqtt(z2mData: string, dataDir: string, log: PluginContext['log']): Record<string, string> {
  const cfgFile = join(z2mData, 'configuration.yaml');
  if (!existsSync(cfgFile)) throw new Error(`${cfgFile} not found`);
  const cfg = (parse(readFileSync(cfgFile, 'utf8')) ?? {}) as { advanced?: Record<string, unknown>; devices?: Record<string, { friendly_name?: string }> };
  const names = Object.fromEntries(Object.entries(cfg.devices ?? {}).map(([ieee, d]) => [ieee, d.friendly_name ?? ieee]));
  if (existsSync(join(dataDir, 'database.db'))) return names; // already taken over
  const adv = cfg.advanced ?? {};
  const numbers = (v: unknown) => (Array.isArray(v) && v.every((n) => typeof n === 'number') ? (v as number[]) : undefined);
  const panID = typeof adv.pan_id === 'number' ? adv.pan_id : typeof adv.pan_id === 'string' && /^0x/i.test(adv.pan_id) ? parseInt(adv.pan_id, 16) : undefined;
  const network: Partial<NetworkSettings> = {
    panID,
    extendedPanID: numbers(adv.ext_pan_id),
    networkKey: numbers(adv.network_key),
    channel: typeof adv.channel === 'number' ? adv.channel : 11,
  };
  if (!network.panID || !network.extendedPanID || !network.networkKey) {
    throw new Error('Zigbee2MQTT configuration.yaml has no explicit pan_id/ext_pan_id/network_key (still "GENERATE"?); start Zigbee2MQTT once so it writes them');
  }
  writeFileSync(join(dataDir, 'network.json'), JSON.stringify(network, null, 2), { mode: 0o600 });
  for (const f of ['database.db', 'coordinator_backup.json']) if (existsSync(join(z2mData, f))) copyFileSync(join(z2mData, f), join(dataDir, f));
  log.info(`took over the Zigbee2MQTT network (${Object.keys(names).length} named devices)`);
  return names;
}

export function createZigbeePlugin(factories: { createController(options: Record<string, unknown>): Promise<ZhController>; converters(): Promise<Converters> }): PluginDefinition {
  return defineAdapter({
    async setup(ctx) {
      const port = ctx.config.serialPort;
      if (typeof port !== 'string' || !port) throw new Error('config.serialPort is required (e.g. /dev/ttyUSB0 or tcp://host:6638)');
      let names: Record<string, string> = {};
      if (typeof ctx.config.takeOverZigbee2mqtt === 'string') names = takeOverZigbee2mqtt(ctx.config.takeOverZigbee2mqtt, ctx.dataDir, ctx.log);
      const network = loadOrCreateNetwork(ctx.dataDir, Number(ctx.config.channel ?? 11));
      const controller = await factories.createController({
        network: { panID: network.panID, extendedPanID: network.extendedPanID, networkKey: network.networkKey, channelList: [network.channel] },
        transport: { path: port, adapter: ctx.config.adapter, baudRate: ctx.config.baudRate, rtscts: ctx.config.rtscts },
        databasePath: join(ctx.dataDir, 'database.db'),
        databaseBackupPath: join(ctx.dataDir, 'database.db.backup'),
        backupPath: join(ctx.dataDir, 'coordinator_backup.json'),
        adapter: { disableLED: Boolean(ctx.config.disableLED), concurrent: ctx.config.concurrent },
        acceptJoiningDeviceHandler: async () => true,
      });
      const bridge = new ZigbeeBridge(ctx, controller, await factories.converters(), { friendlyNames: names });
      ctx.onStop(() => bridge.stop());
      await bridge.start();
    },
  });
}

export default createZigbeePlugin({
  // Loaded lazily: native serialport bindings and the device database only when the plugin is used.
  createController: async (options) => new (await import('zigbee-herdsman')).Controller(options as never) as unknown as ZhController,
  converters: async () => (await import('zigbee-herdsman-converters')) as unknown as Converters,
});
