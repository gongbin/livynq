import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LevelControl, validate, levelToPercent, percentToLevel, slugify, suggestEntityId, getDeviceType, DeviceTypes } from '@livynq/model';

test('validate command params against capability schema', () => {
  const schema = LevelControl.commands.moveToLevel;
  assert.deepEqual(validate(schema, { level: 100 }), []);
  assert.match(validate(schema, { level: 300 })[0]!, /<= 254/);
  assert.match(validate(schema, {})[0]!, /required/);
  assert.match(validate(schema, { level: 10, bogus: 1 })[0]!, /unknown property/);
});

test('level/percent conversion round-trips at the edges', () => {
  assert.equal(levelToPercent(1), 0);
  assert.equal(levelToPercent(254), 100);
  assert.equal(percentToLevel(0), 1);
  assert.equal(percentToLevel(100), 254);
  for (let p = 0; p <= 100; p++) assert.equal(levelToPercent(percentToLevel(p)), p);
});

test('slugify and entity id suggestions', () => {
  assert.equal(slugify('Living Room Ceiling'), 'living_room_ceiling');
  assert.equal(slugify('Café  Lamp!'), 'cafe_lamp');
  assert.equal(slugify('客厅主灯'), '');
  assert.equal(suggestEntityId('light', { name: '客厅主灯', fallback: 'zigbee 0x00158d' }), 'light.zigbee_0x00158d');
  assert.equal(suggestEntityId('sensor', { name: 'Bedroom', endpointName: 'Temperature', fallback: 'x' }), 'sensor.bedroom_temperature');
});

test('device types expose their entity domain', () => {
  assert.equal(getDeviceType(DeviceTypes.DimmableLight.id)?.domain, 'light');
  assert.equal(getDeviceType('nope'), undefined);
});
