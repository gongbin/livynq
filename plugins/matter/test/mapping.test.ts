import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeToUpdates, commandToMatter, planEndpoint } from '../src/mapping.ts';

test('device types + present clusters → Livynq endpoint plans', () => {
  assert.deepEqual(planEndpoint({ number: 1, deviceTypes: [0x010d], clusters: { onOff: {}, levelControl: {}, colorControl: {} } }), {
    deviceType: 'light.extendedColor',
    capabilities: ['onOff', 'colorControl', 'levelControl'],
  });
  assert.deepEqual(planEndpoint({ number: 1, deviceTypes: [0x010a], clusters: { onOff: {}, electricalPowerMeasurement: {} } }), {
    deviceType: 'plug.onOff',
    capabilities: ['onOff', 'electricalPowerMeasurement'],
  });
  assert.equal(planEndpoint({ number: 1, deviceTypes: [0x0301], clusters: { thermostat: {} } })?.deviceType, 'climate.thermostat');
  assert.equal(planEndpoint({ number: 1, deviceTypes: [0x0100], clusters: {} }), undefined, 'required cluster missing');
  assert.equal(planEndpoint({ number: 1, deviceTypes: [0x9999], clusters: { onOff: {} } }), undefined);
});

test('Matter attribute units and enums → Livynq', () => {
  const plan = { deviceType: 'cover.window', capabilities: ['windowCovering' as const] };
  assert.deepEqual(attributeToUpdates(plan, 'windowCovering', 'currentPositionLiftPercent100ths', 7000, {}), [{ capability: 'windowCovering', attributes: { currentPosition: 30 } }]);
  const t = { deviceType: 'climate.thermostat', capabilities: ['thermostat' as const] };
  assert.deepEqual(attributeToUpdates(t, 'thermostat', 'localTemperature', 2150, {}), [{ capability: 'thermostat', attributes: { localTemperature: 21.5 } }]);
  assert.deepEqual(attributeToUpdates(t, 'thermostat', 'controlSequenceOfOperation', 4, {}), [{ capability: 'thermostat', attributes: { supportedModes: 'off,heat,cool,auto' } }]);
  const clusters = { thermostat: { systemMode: 3, occupiedHeatingSetpoint: 2000, occupiedCoolingSetpoint: 2400 } };
  assert.deepEqual(attributeToUpdates(t, 'thermostat', 'systemMode', 3, clusters), [{ capability: 'thermostat', attributes: { systemMode: 'cool', targetTemperature: 24 } }]);
  assert.deepEqual(attributeToUpdates(t, 'thermostat', 'occupiedHeatingSetpoint', 2100, clusters), [], 'heating setpoint ignored in cool mode');
  const s = { deviceType: 'sensor.light', capabilities: ['illuminanceMeasurement' as const] };
  assert.deepEqual(attributeToUpdates(s, 'illuminanceMeasurement', 'measuredValue', 30001, {}), [{ capability: 'illuminanceMeasurement', attributes: { measuredValue: 1000 } }]);
});

test('Livynq commands → Matter invocations and writes', () => {
  assert.deepEqual(commandToMatter('windowCovering', 'goToPosition', { position: 25 }, {}), [{ kind: 'command', cluster: 'windowCovering', command: 'goToLiftPercentage', request: { liftPercent100thsValue: 7500 } }]);
  assert.deepEqual(commandToMatter('thermostat', 'setTargetTemperature', { temperature: 22.5 }, { thermostat: { systemMode: 4, occupiedHeatingSetpoint: 2000 } }), [
    { kind: 'write', cluster: 'thermostat', attribute: 'occupiedHeatingSetpoint', value: 2250 },
  ]);
  assert.equal(commandToMatter('doorLock', 'unlock', {}, {})[0]!.kind === 'command' && (commandToMatter('doorLock', 'unlock', {}, {})[0] as { timed?: boolean }).timed, true, 'lock commands are timed');
});

test('Matter fans: on/off comes from fanMode', () => {
  const plan = planEndpoint({ number: 1, deviceTypes: [0x002b], clusters: { fanControl: { fanMode: 0 } } })!;
  assert.deepEqual(plan, { deviceType: 'fan.fan', capabilities: ['onOff', 'fanControl'] });
  assert.deepEqual(attributeToUpdates(plan, 'fanControl', 'fanMode', 2, { fanControl: {} }), [
    { capability: 'fanControl', attributes: { fanMode: 'medium' } },
    { capability: 'onOff', attributes: { onOff: true } },
  ]);
  assert.deepEqual(commandToMatter('onOff', 'off', {}, { fanControl: { fanMode: 2 } }), [{ kind: 'write', cluster: 'fanControl', attribute: 'fanMode', value: 0 }]);
});
