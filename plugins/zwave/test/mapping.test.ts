import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CC, commandToWrites, planFeatures, sceneToUpdate, valueToUpdates } from '../src/mapping.ts';

const v = (commandClass: number, property: string | number, propertyKey?: string | number, endpoint = 0) => ({ commandClass, endpoint, property, ...(propertyKey !== undefined ? { propertyKey } : {}) });

test('Z-Wave values → features', () => {
  const dimmer = planFeatures({ generic: 0x11, specific: 0x01, values: [v(CC.MultilevelSwitch, 'currentValue'), v(CC.MultilevelSwitch, 'targetValue')] });
  assert.deepEqual(dimmer.map((f) => [f.key, f.deviceType]), [['ep0:dimmer', 'light.dimmable']]);
  const shade = planFeatures({ generic: 0x11, specific: 0x06, values: [v(CC.MultilevelSwitch, 'currentValue'), v(CC.MultilevelSwitch, 'targetValue')] });
  assert.equal(shade[0]!.deviceType, 'cover.window');

  const plug = planFeatures({ generic: 0x10, specific: 0x01, values: [v(CC.BinarySwitch, 'currentValue'), v(CC.BinarySwitch, 'targetValue'), v(CC.Meter, 'value', 66049)], isPowerMeter: () => true });
  assert.deepEqual(plug[0]!.capabilities, ['onOff', 'electricalPowerMeasurement']);
  assert.equal(plug[0]!.deviceType, 'plug.onOff');

  // Two-channel relay: root mirrors endpoint 1 and is skipped
  const relay = planFeatures({ generic: 0x10, values: [v(CC.BinarySwitch, 'currentValue'), v(CC.BinarySwitch, 'currentValue', undefined, 1), v(CC.BinarySwitch, 'currentValue', undefined, 2)] });
  assert.deepEqual(relay.map((f) => [f.key, f.name]), [['ep1:switch', 'Switch 1'], ['ep2:switch', 'Switch 2']]);

  const multi = planFeatures({
    values: [
      v(CC.MultilevelSensor, 'Air temperature'),
      v(CC.MultilevelSensor, 'Illuminance'),
      v(CC.Notification, 'Home Security', 'Motion sensor status'),
      v(CC.Notification, 'Access Control', 'Door state (simple)'),
      v(CC.Battery, 'level'),
      v(CC.CentralScene, 'scene', '001'),
    ],
  });
  assert.deepEqual(multi.map((f) => f.kind).sort(), ['battery', 'contact', 'motion', 'scene', 'sensor', 'sensor']);

  const tstat = planFeatures({ values: [v(CC.ThermostatMode, 'mode'), v(CC.ThermostatSetpoint, 'setpoint', 1), v(CC.MultilevelSensor, 'Air temperature')] });
  assert.deepEqual(tstat.map((f) => f.kind), ['thermostat'], 'its own temperature reading is folded in');
});

test('value updates and commands', () => {
  const [dimmer] = planFeatures({ values: [v(CC.MultilevelSwitch, 'currentValue'), v(CC.MultilevelSwitch, 'targetValue')] });
  assert.deepEqual(valueToUpdates(dimmer!, v(CC.MultilevelSwitch, 'currentValue'), 99), [
    { capability: 'onOff', attributes: { onOff: true } },
    { capability: 'levelControl', attributes: { currentLevel: 254 } },
  ]);
  assert.deepEqual(valueToUpdates(dimmer!, v(CC.MultilevelSwitch, 'currentValue'), 0), [{ capability: 'onOff', attributes: { onOff: false } }]);
  assert.deepEqual(commandToWrites(dimmer!, 'levelControl', 'moveToLevel', { level: 128 }, {}), [{ valueId: v(CC.MultilevelSwitch, 'targetValue'), value: 50 }]);
  assert.equal(commandToWrites(dimmer!, 'onOff', 'toggle', {}, { on: true })[0]!.value, 0);

  const [contact] = planFeatures({ values: [v(CC.Notification, 'Access Control', 'Door state (simple)')] });
  assert.deepEqual(valueToUpdates(contact!, v(CC.Notification, 'Access Control', 'Door state (simple)'), 22), [{ capability: 'booleanState', attributes: { stateValue: false } }], '22 = open');
  const [sensor] = planFeatures({ values: [v(CC.MultilevelSensor, 'Air temperature')] });
  assert.deepEqual(valueToUpdates(sensor!, v(CC.MultilevelSensor, 'Air temperature'), 68, '°F'), [{ capability: 'temperatureMeasurement', attributes: { measuredValue: 20 } }]);

  const [lock] = planFeatures({ values: [v(CC.DoorLock, 'currentMode'), v(CC.DoorLock, 'targetMode')] });
  assert.deepEqual(valueToUpdates(lock!, v(CC.DoorLock, 'currentMode'), 255), [{ capability: 'doorLock', attributes: { lockState: 'locked' } }]);
  assert.deepEqual(commandToWrites(lock!, 'doorLock', 'unlock', {}, {}), [{ valueId: v(CC.DoorLock, 'targetMode'), value: 0 }]);

  assert.equal(sceneToUpdate('001', 3)?.attributes.lastEvent, 'double');
  assert.throws(() => commandToWrites(lock!, 'onOff', 'on', {}, {}));
});
