import {
  degreesToHue,
  hueToDegrees,
  levelToPercent,
  percentToLevel,
  percentToSat,
  satToPercent,
  type AttributeValue,
  type Device,
  type DeviceState,
} from '@livynq/model';

type EndpointState = Record<string, Record<string, AttributeValue>>;
type HapValue = boolean | number | string | null;

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
  /**
   * Event-only characteristic (ProgrammableSwitchEvent): reads return null and a value is sent only
   * when this attribute changes — never on startup or reconnect, which would look like a button press.
   */
  eventOn?: { capability: string; attribute: string };
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
/**
 * `state` (current device state) only informs fixed layout choices such as which thermostat
 * modes to offer; values are always read live.
 */
export function servicesFor(device: Device, state: DeviceState = {}): ServicePlan[] {
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

    if (caps.has('windowCovering')) {
      const garage = ep.deviceType === 'cover.garage' || ep.deviceType === 'cover.gate';
      const pos = (s: EndpointState) => num(s.windowCovering?.currentPosition, 0);
      const status = (s: EndpointState) => s.windowCovering?.operationalStatus;
      if (garage) {
        // CurrentDoorState: 0 open, 1 closed, 2 opening, 3 closing, 4 stopped
        plans.push({
          ...base,
          service: 'GarageDoorOpener',
          characteristics: [
            { name: 'CurrentDoorState', read: (s) => (status(s) === 'opening' ? 2 : status(s) === 'closing' ? 3 : pos(s) > 0 ? 0 : 1) },
            {
              name: 'TargetDoorState',
              read: (s) => (status(s) === 'opening' ? 0 : status(s) === 'closing' ? 1 : pos(s) > 0 ? 0 : 1),
              write: { commands: ({ TargetDoorState }) => [{ capability: 'windowCovering', command: Number(TargetDoorState) === 0 ? 'open' : 'close' }] },
            },
            { name: 'ObstructionDetected', read: (s) => bool(s.windowCovering?.obstructed) },
          ],
        });
      } else {
        // PositionState: 0 decreasing, 1 increasing, 2 stopped
        plans.push({
          ...base,
          service: 'WindowCovering',
          characteristics: [
            { name: 'CurrentPosition', read: (s) => Math.round(pos(s)) },
            {
              name: 'TargetPosition',
              read: (s) => Math.round(num(s.windowCovering?.targetPosition, pos(s))),
              write: { commands: ({ TargetPosition }) => [{ capability: 'windowCovering', command: 'goToPosition', params: { position: Math.round(Number(TargetPosition)) } }] },
            },
            { name: 'PositionState', read: (s) => (status(s) === 'closing' ? 0 : status(s) === 'opening' ? 1 : 2) },
          ],
        });
      }
      continue;
    }
    if (caps.has('thermostat')) {
      const mode = (s: EndpointState) => s.thermostat?.systemMode;
      const supported = String(state[ep.id]?.thermostat?.supportedModes ?? 'off,heat,cool,auto').split(',');
      const valid = [0, 1, 2, 3].filter((v) => supported.includes(['off', 'heat', 'cool', 'auto'][v]!));
      plans.push({
        ...base,
        service: 'Thermostat',
        characteristics: [
          { name: 'CurrentTemperature', props: { minValue: -50, maxValue: 100 }, read: (s) => num(s.thermostat?.localTemperature, 20) },
          {
            name: 'TargetTemperature',
            props: { minValue: 10, maxValue: 38, minStep: 0.5 },
            read: (s) => Math.min(38, Math.max(10, num(s.thermostat?.targetTemperature, 22))),
            write: { commands: ({ TargetTemperature }) => [{ capability: 'thermostat', command: 'setTargetTemperature', params: { temperature: Number(TargetTemperature) } }] },
          },
          // 0 off, 1 heat, 2 cool
          { name: 'CurrentHeatingCoolingState', read: (s) => (s.thermostat?.runningState === 'heating' ? 1 : s.thermostat?.runningState === 'cooling' ? 2 : 0) },
          {
            // 0 off, 1 heat, 2 cool, 3 auto. HomeKit has no dry / fan-only: shown as auto.
            name: 'TargetHeatingCoolingState',
            props: valid.length ? { validValues: valid } : undefined,
            read: (s) => (mode(s) === 'off' || mode(s) === undefined ? 0 : mode(s) === 'heat' ? 1 : mode(s) === 'cool' ? 2 : 3),
            write: { commands: ({ TargetHeatingCoolingState }) => [{ capability: 'thermostat', command: 'setSystemMode', params: { mode: ['off', 'heat', 'cool', 'auto'][Number(TargetHeatingCoolingState)] ?? 'auto' } }] },
          },
          { name: 'TemperatureDisplayUnits', read: () => 0 },
        ],
      });
      continue;
    }
    if (ep.deviceType === 'fan.fan') {
      plans.push({
        ...base,
        service: 'Fanv2',
        characteristics: [
          { name: 'Active', read: (s) => (bool(s.onOff?.onOff) ? 1 : 0), write: { commands: ({ Active }) => [{ capability: 'onOff', command: Number(Active) === 1 ? 'on' : 'off' }] } },
          {
            name: 'RotationSpeed',
            read: (s) => num(s.fanControl?.percentCurrent, 0),
            write: {
              commands: ({ RotationSpeed }) =>
                Number(RotationSpeed) <= 0 ? [{ capability: 'onOff', command: 'off' }] : [{ capability: 'fanControl', command: 'setPercent', params: { percent: Math.round(Number(RotationSpeed)) } }],
            },
          },
        ],
      });
      continue;
    }
    if (caps.has('doorLock')) {
      const lockState = (s: EndpointState) => s.doorLock?.lockState;
      plans.push({
        ...base,
        service: 'LockMechanism',
        characteristics: [
          // 0 unsecured, 1 secured, 2 jammed, 3 unknown
          { name: 'LockCurrentState', read: (s) => (lockState(s) === 'unlocked' ? 0 : lockState(s) === 'locked' ? 1 : lockState(s) === 'jammed' ? 2 : 3) },
          {
            name: 'LockTargetState',
            read: (s) => (lockState(s) === 'unlocked' ? 0 : 1),
            write: { commands: ({ LockTargetState }) => [{ capability: 'doorLock', command: Number(LockTargetState) === 0 ? 'unlock' : 'lock' }] },
          },
        ],
      });
      continue;
    }
    if (caps.has('genericSwitch')) {
      plans.push({
        ...base,
        service: 'StatelessProgrammableSwitch',
        characteristics: [
          {
            // 0 single, 1 double, 2 long; "release" has no HomeKit equivalent
            name: 'ProgrammableSwitchEvent',
            props: { validValues: [0, 1, 2] },
            eventOn: { capability: 'genericSwitch', attribute: 'lastEventAt' },
            read: (s) => {
              const e = s.genericSwitch?.lastEvent;
              return e === 'single' ? 0 : e === 'double' ? 1 : e === 'long' ? 2 : null;
            },
          },
        ],
      });
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

export interface AccessoryPlan {
  /** Stable key: the device id, or "<device id>#<endpoint>" for split channels. Also seeds the HAP UUID. */
  key: string;
  name: string;
  services: ServicePlan[];
}

const CONTROLLABLE = new Set(['Lightbulb', 'Outlet', 'Switch', 'WindowCovering', 'GarageDoorOpener', 'Thermostat', 'Fanv2', 'LockMechanism']);

/**
 * Multi-channel devices (2-gang switches, power strips) get one accessory per channel so each
 * can live in its own room / scene in Apple Home. The first channel stays on the device's own
 * accessory (keeping its UUID stable), together with any sensors and the battery.
 */
export function accessoriesFor(device: Device, state: DeviceState = {}): AccessoryPlan[] {
  const services = servicesFor(device, state);
  if (!services.length) return [];
  const controllable = services.filter((s) => CONTROLLABLE.has(s.service));
  if (controllable.length <= 1) return [{ key: device.id, name: device.name, services }];
  const [first, ...rest] = controllable;
  const main = services.filter((s) => !rest.includes(s));
  return [
    { key: device.id, name: first!.name ? `${device.name} ${first!.name}` : device.name, services: main.map((s) => (s === first ? { ...s, name: undefined } : s)) },
    ...rest.map((s) => ({ key: `${device.id}#${s.endpointId}`, name: `${device.name} ${s.name ?? s.endpointId}`, services: [{ ...s, name: undefined }] })),
  ];
}
