import {
  degreesToHue,
  hueToDegrees,
  levelToPercent,
  percentToLevel,
  percentToSat,
  satToPercent,
  type AttributeValue,
  type Device,
} from '@livynq/model';

type EndpointState = Record<string, Record<string, AttributeValue>>;
type HapValue = boolean | number | string;

export interface CommandSpec {
  capability: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface CharacteristicBinding {
  /** HAP-NodeJS `Characteristic` class name, e.g. "Brightness". */
  name: string;
  props?: Record<string, unknown>;
  read(state: EndpointState): HapValue;
  write?: {
    /** Writes sharing a key within 100 ms are merged into one command (Hue + Saturation). */
    coalesceKey?: string;
    commands(values: Record<string, HapValue>, state: EndpointState): CommandSpec[];
  };
}

export interface ServicePlan {
  /** Stable service subtype: keeps HAP instance ids stable. */
  key: string;
  endpointId: number;
  /** HAP-NodeJS `Service` class name. */
  service: string;
  name?: string;
  characteristics: CharacteristicBinding[];
}

const num = (v: AttributeValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: AttributeValue | undefined): boolean => v === true;

/** Declarative capability → HAP service mapping (design doc §8.3.3). */
export function servicesFor(device: Device): ServicePlan[] {
  const plans: ServicePlan[] = [];
  const multi = device.endpoints.length > 1;
  let battery: ServicePlan | undefined;

  for (const ep of device.endpoints) {
    const caps = new Set<string>(ep.capabilities);
    const base = { key: `ep${ep.id}`, endpointId: ep.id, name: multi ? ep.name : undefined };

    if (ep.deviceType.startsWith('light.')) {
      const characteristics: CharacteristicBinding[] = [onBinding()];
      if (caps.has('levelControl')) {
        characteristics.push({
          name: 'Brightness',
          read: (s) => levelToPercent(num(s.levelControl?.currentLevel, 254)),
          write: {
            commands: ({ Brightness }) =>
              Number(Brightness) <= 0
                ? [{ capability: 'onOff', command: 'off' }]
                : [{ capability: 'levelControl', command: 'moveToLevel', params: { level: percentToLevel(Number(Brightness)) } }],
          },
        });
      }
      if (caps.has('colorControl')) {
        characteristics.push({
          name: 'ColorTemperature',
          props: { minValue: 140, maxValue: 500 },
          read: (s) => Math.min(500, Math.max(140, num(s.colorControl?.colorTemperatureMireds, 300))),
          write: { commands: ({ ColorTemperature }) => [{ capability: 'colorControl', command: 'moveToColorTemperature', params: { colorTemperatureMireds: Number(ColorTemperature) } }] },
        });
        if (ep.deviceType === 'light.extendedColor') {
          const hsWrite: CharacteristicBinding['write'] = {
            coalesceKey: 'hs',
            commands: ({ Hue, Saturation }, s) => [
              {
                capability: 'colorControl',
                command: 'moveToHueAndSaturation',
                params: {
                  hue: Hue === undefined ? num(s.colorControl?.currentHue, 0) : degreesToHue(Number(Hue)),
                  saturation: Saturation === undefined ? num(s.colorControl?.currentSaturation, 0) : percentToSat(Number(Saturation)),
                },
              },
            ],
          };
          characteristics.push(
            { name: 'Hue', read: (s) => hueToDegrees(num(s.colorControl?.currentHue, 0)), write: hsWrite },
            { name: 'Saturation', read: (s) => satToPercent(num(s.colorControl?.currentSaturation, 0)), write: hsWrite },
          );
        }
      }
      plans.push({ ...base, service: 'Lightbulb', characteristics });
      continue;
    }

    if (ep.deviceType === 'plug.onOff') {
      const characteristics: CharacteristicBinding[] = [onBinding()];
      characteristics.push({
        name: 'OutletInUse',
        read: (s) => (s.electricalPowerMeasurement ? num(s.electricalPowerMeasurement.activePower, 0) > 1 : bool(s.onOff?.onOff)),
      });
      plans.push({ ...base, service: 'Outlet', characteristics });
      continue;
    }
    if (ep.deviceType === 'switch.onOff') {
      plans.push({ ...base, service: 'Switch', characteristics: [onBinding()] });
      continue;
    }
    if (caps.has('temperatureMeasurement')) {
      plans.push({
        ...base,
        service: 'TemperatureSensor',
        characteristics: [{ name: 'CurrentTemperature', props: { minValue: -100, maxValue: 100 }, read: (s) => num(s.temperatureMeasurement?.measuredValue, 0) }],
      });
    }
    if (caps.has('relativeHumidityMeasurement')) {
      plans.push({ ...base, service: 'HumiditySensor', characteristics: [{ name: 'CurrentRelativeHumidity', read: (s) => num(s.relativeHumidityMeasurement?.measuredValue, 0) }] });
    }
    if (caps.has('illuminanceMeasurement')) {
      plans.push({
        ...base,
        service: 'LightSensor',
        characteristics: [{ name: 'CurrentAmbientLightLevel', read: (s) => Math.min(100000, Math.max(0.0001, num(s.illuminanceMeasurement?.measuredValue, 0.0001))) }],
      });
    }
    if (caps.has('occupancySensing')) {
      plans.push({ ...base, service: 'MotionSensor', characteristics: [{ name: 'MotionDetected', read: (s) => bool(s.occupancySensing?.occupied) }] });
    }
    if (caps.has('booleanState')) {
      plans.push(
        ep.deviceType === 'binarySensor.leak'
          ? { ...base, service: 'LeakSensor', characteristics: [{ name: 'LeakDetected', read: (s) => (bool(s.booleanState?.stateValue) ? 1 : 0) }] }
          : // ContactSensorState: 0 = contact detected (closed), 1 = not detected (open)
            { ...base, service: 'ContactSensor', characteristics: [{ name: 'ContactSensorState', read: (s) => (s.booleanState?.stateValue === false ? 1 : 0) }] },
      );
    }
    if (caps.has('powerSource') && !battery) {
      battery = {
        key: `battery${ep.id}`,
        endpointId: ep.id,
        service: 'Battery',
        characteristics: [
          { name: 'BatteryLevel', read: (s) => Math.round(num(s.powerSource?.batPercentRemaining, 100)) },
          { name: 'StatusLowBattery', read: (s) => (bool(s.powerSource?.batChargeLevelLow) || num(s.powerSource?.batPercentRemaining, 100) < 20 ? 1 : 0) },
          { name: 'ChargingState', read: () => 2 /* NOT_CHARGEABLE */ },
        ],
      };
    }
  }
  // A battery alone is not useful in Apple Home; attach it only next to a real service.
  if (battery && plans.length) plans.push(battery);
  return plans;
}

function onBinding(): CharacteristicBinding {
  return {
    name: 'On',
    read: (s) => bool(s.onOff?.onOff),
    write: { commands: ({ On }) => [{ capability: 'onOff', command: On ? 'on' : 'off' }] },
  };
}
