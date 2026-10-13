import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { DeviceTypes } from '@livynq/sdk';
import { Home, type Adapter, type AdapterContext } from '@livynq/core';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import bridge from '../src/index.ts';
import { websocketUrl } from '../src/client.ts';

/** Just enough of Home Assistant's WebSocket API. */
function fakeHa(port: number) {
  const calls: Record<string, unknown>[] = [];
  const sockets = new Set<WebSocket>();
  const states: Record<string, unknown>[] = [
    { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen Light', supported_color_modes: ['color_temp'], brightness: 128, color_temp_kelvin: 2700, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500, color_mode: 'color_temp' } },
    { entity_id: 'climate.living', state: 'heat_cool', attributes: { friendly_name: 'Living Room AC', hvac_modes: ['off', 'heat', 'cool', 'heat_cool'], current_temperature: 25, target_temp_low: 20, target_temp_high: 24, hvac_action: 'cooling' } },
    { entity_id: 'sensor.hue_motion_temperature', state: '21.3', attributes: { friendly_name: 'Hue Motion Temperature', device_class: 'temperature', unit_of_measurement: '°C' } },
    { entity_id: 'binary_sensor.hue_motion_occupancy', state: 'off', attributes: { friendly_name: 'Hue Motion Occupancy', device_class: 'motion' } },
    { entity_id: 'sensor.z2m_temperature', state: '19', attributes: { device_class: 'temperature' } },
    { entity_id: 'sensor.excluded_battery', state: '80', attributes: { device_class: 'battery' } },
    { entity_id: 'automation.whatever', state: 'on', attributes: {} },
  ];
  const wss = new WebSocketServer({ port, path: '/api/websocket' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.0' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result }));
      switch (msg.type) {
        case 'auth':
          ws.send(JSON.stringify(msg.access_token === 'good' ? { type: 'auth_ok', ha_version: '2026.10.0' } : { type: 'auth_invalid', message: 'bad token' }));
          return;
        case 'config/area_registry/list':
          return reply([{ area_id: 'living_room', name: 'Living Room' }]);
        case 'config/device_registry/list':
          return reply([
            { id: 'dev-hue', name: 'Hue Motion', name_by_user: 'Hallway Motion', manufacturer: 'Signify', model: 'SML001', area_id: 'living_room', identifiers: [['hue', 'x']] },
            { id: 'dev-z2m', name: 'Z2M Sensor', name_by_user: null, manufacturer: 'Aqara', model: 'X', area_id: null, identifiers: [['mqtt', 'zigbee2mqtt_0xabc']] },
          ]);
        case 'config/entity_registry/list':
          return reply([
            { entity_id: 'sensor.hue_motion_temperature', device_id: 'dev-hue', area_id: null, disabled_by: null, platform: 'hue' },
            { entity_id: 'binary_sensor.hue_motion_occupancy', device_id: 'dev-hue', area_id: null, disabled_by: null, platform: 'hue' },
            { entity_id: 'sensor.z2m_temperature', device_id: 'dev-z2m', area_id: null, disabled_by: null, platform: 'mqtt' },
          ]);
        case 'get_states':
          return reply(states);
        case 'subscribe_events':
          return reply(null);
        case 'call_service':
          calls.push(msg);
          return reply({ context: {} });
      }
    });
  });
  return {
    calls,
    emit: (entity_id: string, new_state: unknown) => {
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'event', event: { event_type: 'state_changed', data: { entity_id, new_state } } }));
    },
    dropConnections: () => sockets.forEach((ws) => ws.terminate()),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

/** Pretends Livynq already integrates the Z2M sensor directly over MQTT. */
class ExistingMqtt implements Adapter {
  readonly id = 'mqtt';
  async start(ctx: AdapterContext) {
    ctx.upsertDevice({ id: 'mqtt:zigbee2mqtt_0xabc', name: 'Z2M Sensor', protocol: 'mqtt', endpoints: [{ id: 1, deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] }] });
  }
  async stop() {}
}

async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

test('websocket url derivation', () => {
  assert.equal(websocketUrl('http://homeassistant.local:8123'), 'ws://homeassistant.local:8123/api/websocket');
  assert.equal(websocketUrl('https://ha.example.com/'), 'wss://ha.example.com/api/websocket');
  assert.equal(websocketUrl('http://supervisor/core'), 'ws://supervisor/core/websocket');
});

test('Home Assistant entities become Livynq devices; state, commands and reconnects', async (t) => {
  const port = 18900 + Math.floor(Math.random() * 500);
  const ha = fakeHa(port);
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new ExistingMqtt()).useAdapter(
    new InProcessPluginAdapter('homeassistant', bridge, { url: `http://127.0.0.1:${port}`, token: 'good', exclude: ['sensor.excluded_*'] }),
  );
  t.after(async () => {
    await home.stop();
    await ha.close();
  });
  await home.start();
  await until(() => home.registry.getDevice('ha:dev-hue')?.availability === 'online' && Boolean(home.registry.getDevice('ha:climate.living')));

  const motion = home.registry.requireDevice('ha:dev-hue');
  assert.equal(motion.name, 'Hallway Motion');
  assert.equal(home.registry.getRoom(motion.roomId!)?.name, 'Living Room');
  assert.deepEqual(motion.endpoints.map((e) => [e.name, e.deviceType]).sort(), [['Occupancy', 'binarySensor.occupancy'], ['Temperature', 'sensor.temperature']]);
  assert.equal(home.registry.getDevice('ha:sensor.z2m_temperature'), undefined, 'already integrated via MQTT: skipped');
  assert.equal(home.registry.getDevice('ha:sensor.excluded_battery'), undefined, 'excluded by config');
  assert.equal(home.registry.getDevice('ha:automation.whatever'), undefined, 'unsupported domain');

  const light = home.registry.requireDevice('ha:light.kitchen');
  assert.equal(light.endpoints[0]!.deviceType, 'light.colorTemperature');
  assert.equal(home.registry.getAttribute(light.id, 1, 'levelControl', 'currentLevel'), 128);
  assert.equal(home.registry.getAttribute(light.id, 1, 'colorControl', 'colorTemperatureMireds'), 370);
  const ac = home.registry.requireDevice('ha:climate.living');
  assert.equal(home.registry.getAttribute(ac.id, 1, 'thermostat', 'systemMode'), 'auto');
  assert.equal(home.registry.getAttribute(ac.id, 1, 'thermostat', 'runningState'), 'cooling');

  await home.command({ deviceId: light.id, endpointId: 1, capability: 'levelControl', command: 'moveToLevel', params: { level: 254 } }, 'test');
  await home.command({ deviceId: ac.id, endpointId: 1, capability: 'thermostat', command: 'setSystemMode', params: { mode: 'cool' } }, 'test');
  assert.deepEqual(ha.calls.map((c) => [c.domain, c.service, c.service_data, c.target]), [
    ['light', 'turn_on', { brightness_pct: 100 }, { entity_id: 'light.kitchen' }],
    ['climate', 'set_hvac_mode', { hvac_mode: 'cool' }, { entity_id: 'climate.living' }],
  ]);

  ha.emit('binary_sensor.hue_motion_occupancy', { entity_id: 'binary_sensor.hue_motion_occupancy', state: 'on', attributes: { device_class: 'motion' } });
  await until(() => home.registry.getAttribute(motion.id, motion.endpoints.find((e) => e.name === 'Occupancy')!.id, 'occupancySensing', 'occupied') === true);

  ha.emit('light.kitchen', { entity_id: 'light.kitchen', state: 'unavailable', attributes: {} });
  await until(() => home.registry.getDevice(light.id)?.availability === 'offline');

  // Connection loss: everything offline, then back after reconnect + resync.
  ha.dropConnections();
  await until(() => home.registry.getDevice(motion.id)?.availability === 'offline');
  await until(() => home.registry.getDevice(motion.id)?.availability === 'online', 5000);
});
