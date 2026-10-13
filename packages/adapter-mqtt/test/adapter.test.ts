import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import mqtt from 'mqtt';
import { Home, silentLogger } from '@livynq/core';
import { MqttAdapter, startBuiltinBroker } from '@livynq/adapter-mqtt';

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
}

test('Zigbee2MQTT-style discovery becomes devices; state and commands flow both ways', async (t) => {
  const port = 18830 + Math.floor(Math.random() * 1000);
  const broker = await startBuiltinBroker({ port, host: '127.0.0.1', log: silentLogger });
  const z2m = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`);
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new MqttAdapter({ url: `mqtt://127.0.0.1:${port}`, settleMs: 50 }));
  t.after(async () => {
    await home.stop();
    await z2m.endAsync();
    await broker.close();
  });

  const device = { identifiers: ['zigbee2mqtt_0x0017880104e45517'], name: 'Hall Bulb', manufacturer: 'Philips', model: 'LCT015', suggested_area: 'Hallway' };
  const sensorDevice = { identifiers: ['zigbee2mqtt_0x00158d0001a2b3c4'], name: 'Bedroom Sensor', manufacturer: 'Aqara' };
  const pub = (topic: string, payload: unknown) => z2m.publishAsync(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain: true });

  // Retained discovery published before Livynq connects, like a real broker after a restart.
  await pub('homeassistant/light/0x0017880104e45517/light/config', {
    schema: 'json', name: null, unique_id: '0x0017880104e45517_light_zigbee2mqtt', state_topic: 'zigbee2mqtt/Hall Bulb', command_topic: 'zigbee2mqtt/Hall Bulb/set',
    brightness: true, brightness_scale: 254, supported_color_modes: ['xy', 'color_temp'], min_mireds: 153, max_mireds: 500,
    availability: [{ topic: 'zigbee2mqtt/bridge/state', value_template: '{{ value_json.state }}' }], device,
  });
  for (const [obj, cls, unit] of [['temperature', 'temperature', '°C'], ['humidity', 'humidity', '%'], ['battery', 'battery', '%']] as const) {
    await pub(`homeassistant/sensor/0x00158d0001a2b3c4/${obj}/config`, {
      name: obj[0]!.toUpperCase() + obj.slice(1), unique_id: `0x00158d0001a2b3c4_${obj}_zigbee2mqtt`, device_class: cls, unit_of_measurement: unit,
      state_topic: 'zigbee2mqtt/Bedroom Sensor', value_template: `{{ value_json.${obj} }}`, device: sensorDevice,
    });
  }
  await pub('homeassistant/binary_sensor/0x00158d0001a2b3c4/contact/config', {
    name: 'Contact', unique_id: '0x00158d0001a2b3c4_contact_zigbee2mqtt', device_class: 'door', state_topic: 'zigbee2mqtt/Bedroom Sensor',
    value_template: '{{ value_json.contact }}', payload_on: false, payload_off: true, device: sensorDevice,
  });
  await pub('homeassistant/sensor/0x00158d0001a2b3c4/pressure/config', { name: 'Pressure', device_class: 'pressure', state_topic: 'x', device: sensorDevice });
  await pub('zigbee2mqtt/bridge/state', { state: 'online' });
  await pub('zigbee2mqtt/Hall Bulb', { state: 'OFF', brightness: 127, color_temp: 370, color_mode: 'color_temp' });
  await pub('zigbee2mqtt/Bedroom Sensor', { temperature: 21.4, humidity: 55, battery: 12, contact: true });

  await home.start();
  await until(() => home.registry.getDevice('mqtt:zigbee2mqtt_0x00158d0001a2b3c4')?.endpoints.length === 4);
  await until(() => home.registry.getDevice('mqtt:zigbee2mqtt_0x0017880104e45517')?.availability === 'online');

  const bulb = home.registry.requireDevice('mqtt:zigbee2mqtt_0x0017880104e45517');
  assert.equal(bulb.name, 'Hall Bulb');
  assert.equal(bulb.info.manufacturer, 'Philips');
  assert.equal(home.registry.getRoom(bulb.roomId!)?.name, 'Hallway');
  assert.equal(bulb.endpoints[0]!.deviceType, 'light.extendedColor');
  await until(() => home.registry.getAttribute(bulb.id, 1, 'levelControl', 'currentLevel') !== undefined);
  assert.equal(home.registry.getAttribute(bulb.id, 1, 'onOff', 'onOff'), false);
  assert.equal(home.registry.getAttribute(bulb.id, 1, 'colorControl', 'colorTemperatureMireds'), 370);
  assert.equal(home.registry.getAttribute(bulb.id, 1, 'colorControl', 'colorMode'), 'ct');

  const sensor = home.registry.requireDevice('mqtt:zigbee2mqtt_0x00158d0001a2b3c4');
  const ep = (name: string) => sensor.endpoints.find((e) => e.name === name)!.id;
  await until(() => home.registry.getAttribute(sensor.id, ep('Contact'), 'booleanState', 'stateValue') !== undefined);
  assert.equal(home.registry.getAttribute(sensor.id, ep('Temperature'), 'temperatureMeasurement', 'measuredValue'), 21.4);
  assert.equal(home.registry.getAttribute(sensor.id, ep('Humidity'), 'relativeHumidityMeasurement', 'measuredValue'), 55);
  assert.equal(home.registry.getAttribute(sensor.id, ep('Battery'), 'powerSource', 'batChargeLevelLow'), true);
  assert.equal(home.registry.getAttribute(sensor.id, ep('Contact'), 'booleanState', 'stateValue'), true, 'contact=true means closed');
  assert.equal(home.registry.entityIdFor(sensor.id, ep('Temperature')), 'sensor.bedroom_sensor_temperature');

  // Command → MQTT publish (Z2M json schema)
  const received: Record<string, unknown>[] = [];
  await z2m.subscribeAsync('zigbee2mqtt/Hall Bulb/set');
  z2m.on('message', (topic, payload) => topic.endsWith('/set') && received.push(JSON.parse(payload.toString())));
  await home.command({ deviceId: bulb.id, endpointId: 1, capability: 'levelControl', command: 'moveToLevel', params: { level: 254 } }, 'test');
  await home.command({ deviceId: bulb.id, endpointId: 1, capability: 'colorControl', command: 'moveToHueAndSaturation', params: { hue: 0, saturation: 254 } }, 'test');
  await until(() => received.length === 2);
  assert.deepEqual(received[0], { state: 'ON', brightness: 254 });
  assert.ok((received[1]!.color as { x: number }).x > 0.6, 'xy-only light receives an xy color');

  // Device reports back → state updates
  await pub('zigbee2mqtt/Hall Bulb', { state: 'ON', brightness: 254 });
  await until(() => home.registry.getAttribute(bulb.id, 1, 'onOff', 'onOff') === true);

  // Availability: bridge offline marks devices offline
  await pub('zigbee2mqtt/bridge/state', { state: 'offline' });
  await until(() => home.registry.getDevice(bulb.id)?.availability === 'offline');

  // Removing the discovery config removes the device
  await pub('homeassistant/light/0x0017880104e45517/light/config', '');
  await until(() => home.registry.getDevice(bulb.id) === undefined);
});

test('Tasmota-style default schema switch with abbreviations', async (t) => {
  const port = 19830 + Math.floor(Math.random() * 1000);
  const broker = await startBuiltinBroker({ port, host: '127.0.0.1', log: silentLogger });
  const tasmota = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`);
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new MqttAdapter({ url: `mqtt://127.0.0.1:${port}`, settleMs: 20 }));
  t.after(async () => {
    await home.stop();
    await tasmota.endAsync();
    await broker.close();
  });
  await home.start();
  await tasmota.publishAsync('homeassistant/switch/A1B2C3_RL_1/config', JSON.stringify({
    name: 'Desk Plug', '~': 'tasmota_A1B2C3/', stat_t: '~stat/POWER', cmd_t: '~cmnd/POWER', pl_on: 'ON', pl_off: 'OFF', dev_cla: 'outlet',
    avty_t: '~tele/LWT', pl_avail: 'Online', pl_not_avail: 'Offline', uniq_id: 'A1B2C3_RL_1', dev: { ids: ['A1B2C3'], name: 'Desk Plug', mf: 'Tasmota' },
  }), { retain: true });
  await until(() => home.registry.getDevice('mqtt:A1B2C3') !== undefined);
  const id = 'mqtt:A1B2C3';
  assert.equal(home.registry.getDevice(id)?.availability, 'unknown');
  await tasmota.publishAsync('tasmota_A1B2C3/tele/LWT', 'Online');
  await until(() => home.registry.getDevice(id)?.availability === 'online');

  const commands: string[] = [];
  await tasmota.subscribeAsync('tasmota_A1B2C3/cmnd/POWER');
  tasmota.on('message', (topic, payload) => topic.endsWith('cmnd/POWER') && commands.push(payload.toString()));
  await home.command({ deviceId: id, endpointId: 1, capability: 'onOff', command: 'on' }, 'test');
  await until(() => commands.length === 1);
  assert.equal(commands[0], 'ON');
  await tasmota.publishAsync('tasmota_A1B2C3/stat/POWER', 'ON');
  await until(() => home.registry.getAttribute(id, 1, 'onOff', 'onOff') === true);
});
