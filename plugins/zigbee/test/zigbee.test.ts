import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zhc from 'zigbee-herdsman-converters';
import { Home } from '@livynq/core';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import { createZigbeePlugin, takeOverZigbee2mqtt } from '../src/index.ts';
import type { Converters, ZhController, ZhDevice } from '../src/bridge.ts';

/** Records ZCL traffic like a real herdsman Endpoint would send it. */
// Converters detect endpoints by class name, so the fake must be called "Endpoint".
class Endpoint {
  ID: number;
  deviceIeeeAddress: string;
  sent: { cluster: string; command: string; payload: unknown }[] = [];
  clusters = {};
  constructor(id: number, ieee: string) {
    this.ID = id;
    this.deviceIeeeAddress = ieee;
  }
  async command(cluster: string, command: string, payload: unknown) {
    this.sent.push({ cluster, command, payload });
  }
  async write(cluster: string, payload: unknown) {
    this.sent.push({ cluster, command: 'write', payload });
  }
  async read() {
    return {};
  }
  device?: ZhDevice;
  getDevice() {
    return this.device;
  }
  supportsInputCluster() {
    return true;
  }
  supportsOutputCluster() {
    return false;
  }
  getClusterAttributeValue() {
    return undefined;
  }
  saveClusterAttributeKeyValue() {}
}

function fakeDevice(ieeeAddr: string, modelID: string, manufacturerName: string): ZhDevice & { endpoints: Endpoint[] } {
  const ep = new Endpoint(1, ieeeAddr);
  const device = {
    ieeeAddr,
    type: 'Router',
    modelID,
    manufacturerName,
    interviewCompleted: true,
    powerSource: 'Mains (single phase)',
    endpoints: [ep],
    getEndpoint: (id: number) => (id === 1 ? ep : undefined),
    meta: {},
    save() {},
    customReadResponse: undefined,
  } as unknown as ZhDevice & { endpoints: Endpoint[] };
  ep.device = device;
  return device;
}

class FakeController extends EventEmitter {
  devices: ZhDevice[];
  permits: number[] = [];
  constructor(devices: ZhDevice[]) {
    super();
    this.devices = devices;
  }
  async start() {}
  async stop() {}
  async permitJoin(s: number) {
    this.permits.push(s);
  }
  getDevices() {
    return this.devices;
  }
  getDevicesByType() {
    return [];
  }
}

const bulb = fakeDevice('0x000b57fffec6a5b2', 'TRADFRI bulb E27 WS opal 980lm', 'IKEA of Sweden');
const outlet = fakeDevice('0x000d6ffffe1e6c4e', 'TRADFRI control outlet', 'IKEA of Sweden');
const weather = fakeDevice('0x00158d0001a2b3c4', 'lumi.weather', 'LUMI');
const door = fakeDevice('0x00158d000233e8f1', 'lumi.sensor_magnet.aq2', 'LUMI');
const msg = (device: ZhDevice, cluster: string, data: Record<string, unknown>) => ({ type: 'attributeReport', device, endpoint: device.endpoints[0], cluster, data, linkquality: 120, groupID: 0, meta: {} });

test('Zigbee devices from the converter database become Livynq devices; ZCL both ways', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-zb-'));
  const controller = new FakeController([bulb, outlet, weather, door]);
  let options: Record<string, unknown> = {};
  const plugin = createZigbeePlugin({
    createController: async (o) => ((options = o), controller as unknown as ZhController),
    converters: async () => zhc as unknown as Converters,
  });
  const home = new Home({ dataDir: dir });
  home.useAdapter(new InProcessPluginAdapter('zigbee', plugin, { serialPort: '/dev/ttyFAKE', adapter: 'ember' }));
  await home.start();

  // Network parameters are generated once and persisted (losing them means re-pairing everything).
  const network = JSON.parse(readFileSync(join(dir, 'plugin-data', 'zigbee', 'network.json'), 'utf8'));
  assert.equal(network.networkKey.length, 16);
  assert.deepEqual((options.network as { channelList: number[] }).channelList, [11]);
  assert.deepEqual(options.transport, { path: '/dev/ttyFAKE', adapter: 'ember', baudRate: undefined, rtscts: undefined });

  const dev = (ieee: string) => home.registry.requireDevice(`zigbee:${ieee}`);
  assert.equal(dev(bulb.ieeeAddr).endpoints[0]!.deviceType, 'light.colorTemperature');
  assert.equal(dev(bulb.ieeeAddr).info.model, 'LED1545G12');
  assert.equal(dev(outlet.ieeeAddr).endpoints[0]!.deviceType, 'plug.onOff');
  assert.deepEqual(dev(weather.ieeeAddr).endpoints.map((e) => e.deviceType).sort(), ['sensor.battery', 'sensor.humidity', 'sensor.temperature']);
  assert.ok(dev(door.ieeeAddr).endpoints.some((e) => e.deviceType === 'binarySensor.contact'));
  assert.ok(home.registry.getDevice('zigbee:permit-join'));

  // Reports → state
  const get = (ieee: string, cap: string, attr: string) => {
    const d = dev(ieee);
    const ep = d.endpoints.find((e) => e.capabilities.includes(cap as never))!;
    return home.registry.getAttribute(d.id, ep.id, cap, attr);
  };
  controller.emit('message', msg(bulb, 'genOnOff', { onOff: 1 }));
  controller.emit('message', msg(bulb, 'genLevelCtrl', { currentLevel: 200 }));
  controller.emit('message', msg(weather, 'msTemperatureMeasurement', { measuredValue: 2150 }));
  controller.emit('message', msg(door, 'genOnOff', { onOff: 0 }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(get(bulb.ieeeAddr, 'onOff', 'onOff'), true);
  assert.equal(get(bulb.ieeeAddr, 'levelControl', 'currentLevel'), 200);
  assert.equal(get(weather.ieeeAddr, 'temperatureMeasurement', 'measuredValue'), 21.5);
  assert.equal(get(door.ieeeAddr, 'booleanState', 'stateValue'), true, 'onOff 0 on a magnet sensor = contact = closed');

  // Commands → ZCL
  const bulbId = dev(bulb.ieeeAddr).id;
  await home.command({ deviceId: bulbId, endpointId: 1, capability: 'onOff', command: 'off' }, 'test');
  await home.command({ deviceId: bulbId, endpointId: 1, capability: 'levelControl', command: 'moveToLevel', params: { level: 100 } }, 'test');
  await home.command({ deviceId: bulbId, endpointId: 1, capability: 'colorControl', command: 'moveToColorTemperature', params: { colorTemperatureMireds: 370 } }, 'test');
  const sent = bulb.endpoints[0]!.sent.map((s) => `${s.cluster}.${s.command}`);
  assert.deepEqual(sent.slice(0, 1), ['genOnOff.off']);
  assert.ok(sent.some((s) => s.startsWith('genLevelCtrl.moveToLevel')), sent.join());
  assert.ok(sent.some((s) => s === 'lightingColorCtrl.moveToColorTemp'), sent.join());
  assert.equal(get(bulb.ieeeAddr, 'onOff', 'onOff'), true, 'brightness command turns the bulb on (converter result)');
  assert.equal(get(bulb.ieeeAddr, 'colorControl', 'colorTemperatureMireds'), 370);

  // Pairing switch
  await home.command({ deviceId: 'zigbee:permit-join', endpointId: 1, capability: 'onOff', command: 'on' }, 'test');
  assert.deepEqual(controller.permits, [254]);

  // Leaving the network removes the device
  controller.emit('deviceLeave', { ieeeAddr: door.ieeeAddr });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(home.registry.getDevice(`zigbee:${door.ieeeAddr}`), undefined);
  await home.stop();
});

test('takes over a Zigbee2MQTT network without re-pairing', () => {
  const z2m = mkdtempSync(join(tmpdir(), 'z2m-'));
  const data = mkdtempSync(join(tmpdir(), 'zb-data-'));
  mkdirSync(z2m, { recursive: true });
  writeFileSync(join(z2m, 'configuration.yaml'), [
    'advanced:',
    '  pan_id: 6754',
    '  ext_pan_id: [221, 221, 221, 221, 221, 221, 221, 221]',
    '  network_key: [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13]',
    '  channel: 25',
    'devices:',
    "  '0x00158d0001a2b3c4':",
    '    friendly_name: Bedroom Sensor',
  ].join('\n'));
  writeFileSync(join(z2m, 'database.db'), '{"id":1}\n');
  writeFileSync(join(z2m, 'coordinator_backup.json'), '{}');
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const names = takeOverZigbee2mqtt(z2m, data, log);
  assert.deepEqual(names, { '0x00158d0001a2b3c4': 'Bedroom Sensor' });
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'network.json'), 'utf8')), {
    panID: 6754,
    extendedPanID: [221, 221, 221, 221, 221, 221, 221, 221],
    networkKey: [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13],
    channel: 25,
  });
  assert.equal(readFileSync(join(data, 'database.db'), 'utf8'), '{"id":1}\n');

  writeFileSync(join(z2m, 'configuration.yaml'), 'advanced:\n  network_key: GENERATE\n');
  assert.throws(() => takeOverZigbee2mqtt(z2m, mkdtempSync(join(tmpdir(), 'zb-data-')), log), /GENERATE/);
});
