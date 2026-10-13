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

test('covers, climate, fans, locks and buttons from Zigbee2MQTT discovery', async (t) => {
  const port = 20830 + Math.floor(Math.random() * 1000);
  const broker = await startBuiltinBroker({ port, host: '127.0.0.1', log: silentLogger });
  const z2m = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`);
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new MqttAdapter({ url: `mqtt://127.0.0.1:${port}`, settleMs: 30 }));
  t.after(async () => {
    await home.stop();
    await z2m.endAsync();
    await broker.close();
  });
  const pub = (topic: string, payload: unknown) => z2m.publishAsync(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain: true });
  const dev = (id: string, name: string) => ({ identifiers: [`zigbee2mqtt_${id}`], name });

  await pub('homeassistant/cover/0xcurtain/cover/config', {
    name: null, unique_id: '0xcurtain_cover_zigbee2mqtt', device: dev('0xcurtain', 'Curtain'),
    command_topic: 'zigbee2mqtt/Curtain/set', position_topic: 'zigbee2mqtt/Curtain', position_template: '{{ value_json.position }}',
    set_position_topic: 'zigbee2mqtt/Curtain/set', set_position_template: '{ "position": {{ position }} }',
    state_topic: 'zigbee2mqtt/Curtain', value_template: '{{ value_json.state }}', state_open: 'OPEN', state_closed: 'CLOSE', state_stopped: 'STOP',
  });
  await pub('homeassistant/climate/0xtrv/climate/config', {
    name: null, unique_id: '0xtrv_climate_zigbee2mqtt', device: dev('0xtrv', 'Radiator'), modes: ['off', 'heat', 'auto'], min_temp: '5', max_temp: '30',
    mode_command_topic: 'zigbee2mqtt/Radiator/set/system_mode', mode_state_topic: 'zigbee2mqtt/Radiator', mode_state_template: '{{ value_json.system_mode }}',
    temperature_command_topic: 'zigbee2mqtt/Radiator/set/occupied_heating_setpoint', temperature_state_topic: 'zigbee2mqtt/Radiator', temperature_state_template: '{{ value_json.occupied_heating_setpoint }}',
    current_temperature_topic: 'zigbee2mqtt/Radiator', current_temperature_template: '{{ value_json.local_temperature }}',
    action_topic: 'zigbee2mqtt/Radiator', action_template: "{% set values = {None:None,'idle':'idle','heat':'heating'} %}{{ values[value_json.running_state] }}",
  });
  await pub('homeassistant/lock/0xlock/lock/config', {
    name: null, unique_id: '0xlock_lock_zigbee2mqtt', device: dev('0xlock', 'Front Lock'), command_topic: 'zigbee2mqtt/Front Lock/set',
    state_topic: 'zigbee2mqtt/Front Lock', value_template: '{{ value_json.state }}', payload_lock: 'LOCK', payload_unlock: 'UNLOCK', state_locked: 'LOCK', state_unlocked: 'UNLOCK',
  });
  await pub('homeassistant/fan/0xfan/fan/config', {
    name: null, unique_id: '0xfan_fan_zigbee2mqtt', device: dev('0xfan', 'Ceiling Fan'), command_topic: 'zigbee2mqtt/Ceiling Fan/set/fan_state',
    state_topic: 'zigbee2mqtt/Ceiling Fan', state_value_template: '{{ value_json.fan_state }}', percentage_command_topic: 'zigbee2mqtt/Ceiling Fan/set/fan_speed',
    percentage_state_topic: 'zigbee2mqtt/Ceiling Fan', percentage_value_template: '{{ value_json.fan_speed }}', speed_range_min: 1, speed_range_max: 9,
  });
  for (const action of ['single', 'double', 'hold']) {
    await pub(`homeassistant/device_automation/0xremote/action_${action}/config`, {
      automation_type: 'trigger', type: 'action', subtype: action, payload: action, topic: 'zigbee2mqtt/Remote/action', device: dev('0xremote', 'Remote'),
    });
  }
  await pub('homeassistant/event/0xknob/action/config', {
    name: 'Action', unique_id: '0xknob_action_zigbee2mqtt', device: dev('0xknob', 'Knob'), state_topic: 'zigbee2mqtt/Knob',
    event_types: ['rotate_left', 'single'], value_template: '{{ {"event_type": value_json.action} | to_json }}',
  });
  await pub('zigbee2mqtt/Curtain', { position: 100, state: 'OPEN' });
  await pub('zigbee2mqtt/Radiator', { system_mode: 'heat', occupied_heating_setpoint: 21, local_temperature: 19.5, running_state: 'heat' });
  await pub('zigbee2mqtt/Front Lock', { state: 'LOCK' });
  await pub('zigbee2mqtt/Ceiling Fan', { fan_state: 'ON', fan_speed: 9 });

  await home.start();
  const id = (x: string) => `mqtt:zigbee2mqtt_${x}`;
  await until(() => ['0xcurtain', '0xtrv', '0xlock', '0xfan', '0xremote', '0xknob'].every((x) => home.registry.getDevice(id(x))));
  await until(() => home.registry.getAttribute(id('0xfan'), 1, 'fanControl', 'percentCurrent') !== undefined);
  const get = (x: string, cap: string, attr: string) => home.registry.getAttribute(id(x), 1, cap, attr);

  assert.equal(home.registry.requireDevice(id('0xtrv')).endpoints[0]!.deviceType, 'climate.thermostat');
  assert.equal(get('0xcurtain', 'windowCovering', 'currentPosition'), 100);
  assert.equal(get('0xtrv', 'thermostat', 'systemMode'), 'heat');
  assert.equal(get('0xtrv', 'thermostat', 'targetTemperature'), 21);
  assert.equal(get('0xtrv', 'thermostat', 'localTemperature'), 19.5);
  assert.equal(get('0xtrv', 'thermostat', 'supportedModes'), 'off,heat,auto');
  assert.equal(get('0xtrv', 'thermostat', 'runningState'), undefined, 'Jinja action template skipped, entity still works');
  assert.equal(get('0xlock', 'doorLock', 'lockState'), 'locked');
  assert.equal(get('0xfan', 'fanControl', 'percentCurrent'), 100);
  assert.equal(home.registry.requireDevice(id('0xremote')).endpoints.length, 1, 'all triggers share one button endpoint');

  const sent: [string, string][] = [];
  await z2m.subscribeAsync('zigbee2mqtt/+/set/#');
  await z2m.subscribeAsync('zigbee2mqtt/+/set');
  z2m.on('message', (topic, payload) => topic.includes('/set') && sent.push([topic, payload.toString()]));
  const cmd = (x: string, capability: string, command: string, params?: Record<string, unknown>) => home.command({ deviceId: id(x), endpointId: 1, capability, command, params }, 'test');
  await cmd('0xcurtain', 'windowCovering', 'goToPosition', { position: 40 });
  await cmd('0xcurtain', 'windowCovering', 'stop');
  await cmd('0xtrv', 'thermostat', 'setTargetTemperature', { temperature: 22.5 });
  await cmd('0xtrv', 'thermostat', 'setSystemMode', { mode: 'off' });
  await assert.rejects(cmd('0xtrv', 'thermostat', 'setSystemMode', { mode: 'cool' }), /not supported/);
  await cmd('0xlock', 'doorLock', 'unlock');
  await cmd('0xfan', 'fanControl', 'setPercent', { percent: 50 });
  await until(() => sent.length === 6);
  assert.deepEqual(sent, [
    ['zigbee2mqtt/Curtain/set', '{ "position": 40 }'],
    ['zigbee2mqtt/Curtain/set', 'STOP'],
    ['zigbee2mqtt/Radiator/set/occupied_heating_setpoint', '22.5'],
    ['zigbee2mqtt/Radiator/set/system_mode', 'off'],
    ['zigbee2mqtt/Front Lock/set', 'UNLOCK'],
    ['zigbee2mqtt/Ceiling Fan/set/fan_speed', '5'],
  ]);

  await z2m.publishAsync('zigbee2mqtt/Remote/action', 'hold');
  await until(() => get('0xremote', 'genericSwitch', 'lastEvent') === 'long');
  assert.equal(get('0xremote', 'genericSwitch', 'lastAction'), 'hold');
  await z2m.publishAsync('zigbee2mqtt/Knob', JSON.stringify({ action: 'rotate_left' }));
  await until(() => get('0xknob', 'genericSwitch', 'lastAction') === 'rotate_left');
});
