import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceTypes } from '@livynq/model';
import { Home, type Adapter, type AdapterContext } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';
import { applyImport, listImports, openSource, planImport, revertImport } from '@livynq/importer-homeassistant';
import { writeHaBackup, writeHaDir } from './fixture.ts';

/** Registers devices exactly like the MQTT adapter does for Zigbee2MQTT discovery. */
class FakeZ2m implements Adapter {
  readonly id = 'mqtt';
  async start(ctx: AdapterContext) {
    const bulb = 'mqtt:zigbee2mqtt_0x0017880104e45517';
    ctx.upsertDevice({
      id: bulb, name: 'Hall Bulb', protocol: 'mqtt',
      endpoints: [{ id: ctx.endpointId(bulb, '0x0017880104e45517_light_zigbee2mqtt'), deviceType: DeviceTypes.ColorTemperatureLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] }],
    }).setAvailability('online');
    const sensor = 'mqtt:zigbee2mqtt_0x00158d0001a2b3c4';
    ctx.upsertDevice({
      id: sensor, name: 'Kitchen Sensor', protocol: 'mqtt',
      endpoints: [
        { id: ctx.endpointId(sensor, '0x00158d0001a2b3c4_temperature_zigbee2mqtt'), name: 'Temperature', deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] },
        { id: ctx.endpointId(sensor, '0x00158d0001a2b3c4_humidity_zigbee2mqtt'), name: 'Humidity', deviceType: DeviceTypes.HumiditySensor.id, capabilities: ['relativeHumidityMeasurement'] },
      ],
    }).setAvailability('online');
  }
  async stop() {}
}

async function setup() {
  const home = new Home({ dataDir: ':memory:' });
  const engine = new AutomationEngine();
  home.useAdapter(new FakeZ2m()).useExtension(engine);
  await home.start();
  home.registry.createRoom({ name: 'Kitchen' });
  return { home, engine };
}

test('plan is a read-only dry run with a precise report', async () => {
  const { home, engine } = await setup();
  const before = JSON.stringify([home.registry.listDevices(), home.registry.listEntities(), home.registry.listRooms()]);
  const plan = planImport(home, engine, openSource(writeHaDir()));
  assert.equal(JSON.stringify([home.registry.listDevices(), home.registry.listEntities(), home.registry.listRooms()]), before, 'planning changes nothing');

  assert.equal(plan.haVersion, '2026.9.3');
  assert.deepEqual(plan.location, { latitude: 31.23, longitude: 121.47, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(plan.rooms.map((r) => [r.name, r.action]), [['Living Room', 'create'], ['Kitchen', 'match']]);
  assert.deepEqual(plan.summary, { rooms: 2, devicesMatched: 2, devicesPending: 1, devicesUnsupported: 1, entityRenames: 2, automations: 1, automationsInvalid: 2 });
  const bulb = plan.devices.find((d) => d.haDeviceId === 'dev-bulb')!;
  assert.deepEqual(bulb.entities, [{ haEntityId: 'light.lounge_lamp', livynqEntityId: 'light.hall_bulb', status: 'rename' }]);
  const sensor = plan.devices.find((d) => d.haDeviceId === 'dev-sensor')!;
  assert.equal(sensor.entities.find((e) => e.haEntityId === 'sensor.kitchen_pressure')?.status, 'missing');
  assert.match(plan.devices.find((d) => d.haDeviceId === 'dev-hue')!.reason!, /Philips Hue: pair the bridge/);
  assert.match(plan.automations.find((a) => a.alias === 'Templated')!.errors[0]!, /templates are not supported/);
  assert.match(plan.automations.find((a) => a.alias === 'Blueprint')!.errors[0]!, /blueprint/);
  assert.deepEqual(plan.notImported, { scripts: 1, scenes: 0, blueprints: 1, floors: 1 });
  assert.deepEqual(plan.warnings, []);
  await home.stop();
});

test('apply renames entities to HA ids so imported automations work; revert undoes everything', async () => {
  const { home, engine } = await setup();
  const plan = planImport(home, engine, openSource(writeHaDir()));
  const record = applyImport(home, engine, plan, 'test', { enableAutomations: true });
  assert.deepEqual(record.applied.failed, []);

  const bulb = home.registry.requireDevice('mqtt:zigbee2mqtt_0x0017880104e45517');
  assert.equal(bulb.name, 'Lounge Lamp');
  assert.equal(home.registry.getRoom(bulb.roomId!)?.name, 'Living Room');
  assert.deepEqual(bulb.aliases, ['big light']);
  assert.equal(home.registry.entityIdFor(bulb.id, 1), 'light.lounge_lamp');
  assert.equal(home.registry.entityIdFor('mqtt:zigbee2mqtt_0x00158d0001a2b3c4', 1), 'sensor.kitchen_temperature');

  // The valid automation is enabled, uses `area_id: living_room` (HA area id → room alias) and works.
  assert.equal(engine.get('1700000000001').enabled, true);
  home.registry.updateState('mqtt:zigbee2mqtt_0x0017880104e45517', 1, 'onOff', { onOff: false }, 'test');
  const run = await engine.waitForRun('1700000000001', engine.trigger('1700000000001')!);
  assert.equal(run.state, 'error', 'no command handler in the fake adapter');
  assert.match(run.error!, /No handler for onOff.on on mqtt:zigbee2mqtt_0x0017880104e45517#1/, 'area target resolved to the bulb');
  // Invalid ones are stored disabled with their errors, for the user to fix.
  assert.equal(engine.get('1700000000002').valid, false);
  assert.equal(engine.get('1700000000002').enabled, false);

  assert.equal(listImports(home)[0]?.id, record.id);
  const reverted = revertImport(home, engine, record.id);
  assert.deepEqual(reverted.skipped, []);
  assert.equal(home.registry.entityIdFor(bulb.id, 1), 'light.hall_bulb');
  assert.equal(home.registry.requireDevice(bulb.id).name, 'Hall Bulb');
  assert.equal(home.registry.requireDevice(bulb.id).nameByUser, false);
  assert.equal(home.registry.findRoom('Living Room'), undefined);
  assert.deepEqual(home.registry.findRoom('Kitchen')?.aliases, []);
  assert.deepEqual(engine.list(), []);
  assert.throws(() => revertImport(home, engine, record.id), /already reverted/);
  await home.stop();
});

test('reads Home Assistant backup archives', async () => {
  const { home, engine } = await setup();
  const plan = planImport(home, engine, openSource(writeHaBackup()));
  assert.equal(plan.summary.devicesMatched, 2);
  assert.equal(plan.summary.automations, 1);
  assert.equal(plan.notImported.blueprints, 1);
  await home.stop();
});
