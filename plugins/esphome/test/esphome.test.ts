import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Home } from '@livynq/core';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import { createEsphomePlugin, type EsphomeClient, type EsphomeEntity } from '../src/index.ts';
import { commandPayload, hsToRgb, planEntity, rgbToHs } from '../src/mapping.ts';

class FakeEntity extends EventEmitter {
  commands: Record<string, unknown>[] = [];
  type: string;
  config: EsphomeEntity['config'];
  state?: Record<string, unknown>;
  constructor(type: string, config: EsphomeEntity['config'], state?: Record<string, unknown>) {
    super();
    this.type = type;
    this.config = config;
    this.state = state;
  }
  command(data: Record<string, unknown>) {
    this.commands.push(data);
  }
}

class FakeNode extends EventEmitter implements EsphomeClient {
  light = new FakeEntity('Light', { key: 11, objectId: 'desk_light', name: 'Desk Light', supportedColorModesList: [11, 35], minMireds: 153, maxMireds: 370 }, { key: 11, state: true, brightness: 0.5, colorMode: 11, colorTemperature: 300 });
  relay = new FakeEntity('Switch', { key: 12, objectId: 'relay', name: 'Relay', deviceClass: 'outlet' }, { key: 12, state: false });
  temp = new FakeEntity('Sensor', { key: 13, objectId: 'temperature', name: 'Temperature', deviceClass: 'temperature', unitOfMeasurement: '°F' }, { key: 13, state: 71.6 });
  door = new FakeEntity('BinarySensor', { key: 14, objectId: 'door', name: 'Door', deviceClass: 'door' }, { key: 14, state: true });
  wifi = new FakeEntity('Sensor', { key: 15, objectId: 'wifi_signal', name: 'WiFi', deviceClass: 'signal_strength' });
  connect() {
    setImmediate(() => {
      this.emit('connected');
      this.emit('deviceInfo', { name: 'desk-node', friendlyName: 'Desk Node', macAddress: 'AA:BB:CC:DD:EE:01', model: 'esp32dev', esphomeVersion: '2026.9.1', suggestedArea: 'Office' });
      for (const e of [this.light, this.relay, this.temp, this.door, this.wifi]) this.emit('newEntity', e);
      this.emit('initialized');
    });
  }
  disconnect() {
    this.emit('disconnected');
  }
}

async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fn(), 'condition not met');
}

test('ESPHome node becomes a Livynq device; state and commands map both ways', async () => {
  const node = new FakeNode();
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new InProcessPluginAdapter('esphome', createEsphomePlugin({ createClient: () => node }), { devices: [{ host: 'desk-node.local' }] }));
  await home.start();
  await until(() => home.registry.getDevice('esphome:aabbccddee01')?.availability === 'online');

  const device = home.registry.requireDevice('esphome:aabbccddee01');
  assert.equal(device.name, 'Desk Node');
  assert.equal(home.registry.getRoom(device.roomId!)?.name, 'Office');
  assert.deepEqual(device.endpoints.map((e) => [e.id, e.name, e.deviceType]), [
    [1, 'Desk Light', 'light.extendedColor'],
    [2, 'Relay', 'plug.onOff'],
    [3, 'Temperature', 'sensor.temperature'],
    [4, 'Door', 'binarySensor.contact'],
  ]);
  const get = (ep: number, cap: string, attr: string) => home.registry.getAttribute(device.id, ep, cap, attr);
  assert.equal(get(1, 'levelControl', 'currentLevel'), 128);
  assert.equal(get(1, 'colorControl', 'colorMode'), 'ct');
  assert.equal(get(3, 'temperatureMeasurement', 'measuredValue'), 22);
  assert.equal(get(4, 'booleanState', 'stateValue'), false, 'door on = open = contact not closed');

  await home.command({ deviceId: device.id, endpointId: 1, capability: 'levelControl', command: 'moveToLevel', params: { level: 254, transitionTime: 10 } }, 'test');
  await home.command({ deviceId: device.id, endpointId: 1, capability: 'colorControl', command: 'moveToHueAndSaturation', params: { hue: 0, saturation: 254 } }, 'test');
  await home.command({ deviceId: device.id, endpointId: 2, capability: 'onOff', command: 'toggle' }, 'test');
  assert.deepEqual(node.light.commands[0], { state: true, brightness: 1, transitionLength: 1000 });
  assert.deepEqual(node.light.commands[1], { state: true, red: 1, green: 0, blue: 0 });
  assert.deepEqual(node.relay.commands[0], { state: true });

  node.light.emit('state', { key: 11, state: true, brightness: 1, colorMode: 35, red: 0, green: 0, blue: 1 });
  assert.equal(get(1, 'colorControl', 'colorMode'), 'hs');
  assert.equal(get(1, 'colorControl', 'currentHue'), 169);

  node.disconnect();
  assert.equal(home.registry.getDevice(device.id)?.availability, 'offline');
  await home.stop();
});

test('mapping details', () => {
  assert.equal(planEntity('Light', { key: 1, objectId: 'l', name: 'l', supportedColorModesList: [3] })?.deviceType, 'light.dimmable');
  assert.equal(planEntity('Light', { key: 1, objectId: 'l', name: 'l', supportedColorModesList: [19] })?.deviceType, 'light.colorTemperature');
  assert.equal(planEntity('Light', { key: 1, objectId: 'l', name: 'l', supportedColorModesList: [1] })?.deviceType, 'light.onOff');
  assert.equal(planEntity('Switch', { key: 1, objectId: 's', name: 's', disabledByDefault: true }), undefined);
  assert.throws(() => commandPayload('Switch', 'levelControl', 'moveToLevel', { level: 3 }, {}), /not supported/);
  for (const [h, s] of [[0, 100], [120, 50], [240, 100], [300, 25]] as const) {
    const { r, g, b } = hsToRgb(h, s);
    assert.deepEqual(rgbToHs(r, g, b), { h, s });
  }
});
