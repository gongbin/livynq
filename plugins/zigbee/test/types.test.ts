import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zhc from 'zigbee-herdsman-converters';
import { commandToZigbee, payloadToUpdates, planEndpoints, type EndpointPlan } from '../src/exposes.ts';

async function plan(modelID: string, manufacturerName: string): Promise<EndpointPlan[]> {
  const ep = { ID: 1 };
  const d = await zhc.findByDevice({ modelID, manufacturerName, type: 'EndDevice', endpoints: [ep], ieeeAddr: '0x1', getEndpoint: () => ep, meta: {} } as never);
  assert.ok(d, `${modelID} in the converter database`);
  const exposes = typeof d.exposes === 'function' ? d.exposes({ ieeeAddr: '0x1', endpoints: [ep] } as never, {}) : d.exposes;
  return planEndpoints(exposes as never, d.description);
}

test('real devices: curtain motor, radiator valve, remote, lock', async () => {
  const [curtain] = await plan('lumi.curtain', 'LUMI');
  assert.equal(curtain!.deviceType, 'cover.window');
  assert.deepEqual(payloadToUpdates(curtain!, { position: 35, moving: 'DOWN' }), [{ capability: 'windowCovering', attributes: { currentPosition: 35, operationalStatus: 'closing' } }]);
  assert.deepEqual(commandToZigbee(curtain!, 'windowCovering', 'goToPosition', { position: 60 }, {}), { key: 'position', value: 60 });

  const [trv] = await plan('eTRV0100', 'Danfoss');
  assert.equal(trv!.deviceType, 'climate.thermostat');
  assert.deepEqual(payloadToUpdates(trv!, { local_temperature: 19.5, occupied_heating_setpoint: 21, system_mode: 'heat', running_state: 'heat' }), [
    { capability: 'thermostat', attributes: { supportedModes: 'heat', localTemperature: 19.5, targetTemperature: 21, systemMode: 'heat', runningState: 'heating' } },
  ]);
  assert.deepEqual(commandToZigbee(trv!, 'thermostat', 'setTargetTemperature', { temperature: 22.5 }, {}), { key: 'occupied_heating_setpoint', value: 22.5 });
  assert.throws(() => commandToZigbee(trv!, 'thermostat', 'setSystemMode', { mode: 'cool' }, {}), /not supported/);

  const remote = (await plan('Remote Control N2', 'IKEA of Sweden')).find((p) => p.deviceType === 'event.button')!;
  const [press] = payloadToUpdates(remote, { action: 'arrow_left_hold' });
  assert.equal(press!.attributes.lastEvent, 'long');
  assert.equal(press!.attributes.lastAction, 'arrow_left_hold');
  assert.deepEqual(payloadToUpdates(remote, { action: '' }), [], 'Z2M clears action with an empty string');

  const lock = (await plan('YRD226 TSDB', 'Yale')).find((p) => p.deviceType === 'lock.door')!;
  assert.deepEqual(payloadToUpdates(lock, { state: 'UNLOCK' }), [{ capability: 'doorLock', attributes: { lockState: 'unlocked' } }]);
  assert.deepEqual(commandToZigbee(lock, 'doorLock', 'lock', {}, {}), { key: 'state', value: 'LOCK' });
});
