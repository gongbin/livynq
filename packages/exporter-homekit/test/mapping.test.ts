import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultExposure, DeviceTypes, type Device } from '@livynq/model';
import { servicesFor } from '@livynq/exporter-homekit';

function device(endpoints: Device['endpoints']): Device {
  return {
    id: 'test:x', name: 'X', protocol: 'virtual', adapter: 'test', info: {}, endpoints, roomId: null, aliases: [],
    availability: 'online', exposure: defaultExposure(), nameByUser: false, createdAt: 0, updatedAt: 0,
  };
}

// Snapshot of the service layout: a change here changes what Apple Home sees (design doc §22.2).
test('HAP service layout per device type', () => {
  const layout = (d: Device) => servicesFor(d).map((p) => `${p.key}:${p.service}[${p.characteristics.map((c) => c.name).join(',')}]`);
  assert.deepEqual(layout(device([{ id: 1, deviceType: DeviceTypes.ExtendedColorLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] }])), [
    'ep1:Lightbulb[On,Brightness,ColorTemperature,Hue,Saturation]',
  ]);
  assert.deepEqual(layout(device([{ id: 1, deviceType: DeviceTypes.OnOffPlugInUnit.id, capabilities: ['onOff'] }])), ['ep1:Outlet[On,OutletInUse]']);
  assert.deepEqual(
    layout(device([
      { id: 1, deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] },
      { id: 2, deviceType: DeviceTypes.HumiditySensor.id, capabilities: ['relativeHumidityMeasurement'] },
      { id: 3, deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'] },
    ])),
    ['ep1:TemperatureSensor[CurrentTemperature]', 'ep2:HumiditySensor[CurrentRelativeHumidity]', 'battery3:Battery[BatteryLevel,StatusLowBattery,ChargingState]'],
  );
  assert.deepEqual(layout(device([{ id: 1, deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'] }])), [], 'battery alone is not exposed');
});

test('characteristic reads and writes convert units', () => {
  const [light] = servicesFor(device([{ id: 1, deviceType: DeviceTypes.ExtendedColorLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] }]));
  const c = (name: string) => light!.characteristics.find((x) => x.name === name)!;
  const state = { onOff: { onOff: true }, levelControl: { currentLevel: 254 }, colorControl: { currentHue: 127, currentSaturation: 254, colorTemperatureMireds: 600 } };
  assert.equal(c('On').read(state), true);
  assert.equal(c('Brightness').read(state), 100);
  assert.equal(c('ColorTemperature').read(state), 500, 'clamped to the HomeKit range');
  assert.equal(c('Hue').read(state), 180);
  assert.deepEqual(c('Brightness').write!.commands({ Brightness: 0 }, state), [{ capability: 'onOff', command: 'off' }]);
  assert.deepEqual(c('Brightness').write!.commands({ Brightness: 50 }, state), [{ capability: 'levelControl', command: 'moveToLevel', params: { level: 128 } }]);
  assert.deepEqual(c('Hue').write!.commands({ Hue: 120 }, state)[0]!.params, { hue: 85, saturation: 254 }, 'missing saturation comes from state');

  const [contact] = servicesFor(device([{ id: 1, deviceType: DeviceTypes.ContactSensor.id, capabilities: ['booleanState'] }]));
  assert.equal(contact!.characteristics[0]!.read({ booleanState: { stateValue: true } }), 0, 'closed = CONTACT_DETECTED');
  assert.equal(contact!.characteristics[0]!.read({ booleanState: { stateValue: false } }), 1);
});
