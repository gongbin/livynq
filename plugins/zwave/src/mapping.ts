import { DeviceTypes, percentToLevel, levelToPercent, type AttributeValue, type CapabilityId } from '@livynq/sdk';

/**
 * Z-Wave (zwave-js value IDs) ⇄ Livynq. Each Z-Wave endpoint can yield several Livynq endpoints
 * ("features"): a dimmer, a temperature reading, a motion notification, a battery…
 */
export const CC = {
  BinarySwitch: 0x25,
  MultilevelSwitch: 0x26,
  BinarySensor: 0x30,
  MultilevelSensor: 0x31,
  Meter: 0x32,
  ThermostatMode: 0x40,
  ThermostatOperatingState: 0x42,
  ThermostatSetpoint: 0x43,
  CentralScene: 0x5b,
  DoorLock: 0x62,
  Notification: 0x71,
  Battery: 0x80,
} as const;

export interface ValueId {
  commandClass: number;
  endpoint?: number;
  property: string | number;
  propertyKey?: string | number;
}

export interface NodeInfo {
  /** Generic / specific device class keys (e.g. 0x11 / 0x06 = multilevel switch / motor control) */
  generic?: number;
  specific?: number;
  values: ValueId[];
  /** Meter metadata: true when the value is electric power in W */
  isPowerMeter?: (v: ValueId) => boolean;
}

export type FeatureKind = 'switch' | 'dimmer' | 'cover' | 'sensor' | 'motion' | 'contact' | 'leak' | 'battery' | 'thermostat' | 'lock' | 'scene';

export interface Feature {
  /** Stable key for ctx.endpointId */
  key: string;
  kind: FeatureKind;
  endpoint: number;
  name?: string;
  deviceType: string;
  capabilities: CapabilityId[];
  /** Value IDs this feature reads and writes */
  values: Record<string, ValueId>;
}

const SENSOR_TYPES: Record<string, { deviceType: string; capability: CapabilityId; name: string }> = {
  'Air temperature': { deviceType: DeviceTypes.TemperatureSensor.id, capability: 'temperatureMeasurement', name: 'Temperature' },
  Humidity: { deviceType: DeviceTypes.HumiditySensor.id, capability: 'relativeHumidityMeasurement', name: 'Humidity' },
  Illuminance: { deviceType: DeviceTypes.LightSensor.id, capability: 'illuminanceMeasurement', name: 'Illuminance' },
  Power: { deviceType: DeviceTypes.PowerSensor.id, capability: 'electricalPowerMeasurement', name: 'Power' },
};

const find = (values: ValueId[], cc: number, endpoint: number, property: string | number, propertyKey?: string | number) =>
  values.find((v) => v.commandClass === cc && (v.endpoint ?? 0) === endpoint && v.property === property && (propertyKey === undefined || v.propertyKey === propertyKey));

export function planFeatures(node: NodeInfo): Feature[] {
  const out: Feature[] = [];
  const endpoints = [...new Set(node.values.map((v) => v.endpoint ?? 0))].sort((a, b) => a - b);
  // Multi-endpoint devices report the same values on the root and endpoint 1 (compat); prefer real endpoints.
  const hasSub = (cc: number) => endpoints.some((e) => e > 0 && node.values.some((v) => v.commandClass === cc && (v.endpoint ?? 0) === e));
  const motor = node.generic === 0x11 && [0x05, 0x06, 0x07].includes(node.specific ?? -1);

  for (const ep of endpoints) {
    const at = (cc: number) => ep > 0 || !hasSub(cc);
    const suffix = endpoints.filter((e) => e > 0).length > 1 && ep > 0 ? ` ${ep}` : '';
    const ml = find(node.values, CC.MultilevelSwitch, ep, 'currentValue');
    if (ml && at(CC.MultilevelSwitch)) {
      const target = find(node.values, CC.MultilevelSwitch, ep, 'targetValue') ?? { ...ml, property: 'targetValue' };
      out.push(
        motor
          ? { key: `ep${ep}:cover`, kind: 'cover', endpoint: ep, name: `Cover${suffix}`, deviceType: DeviceTypes.WindowCovering.id, capabilities: ['windowCovering'], values: { current: ml, target } }
          : { key: `ep${ep}:dimmer`, kind: 'dimmer', endpoint: ep, name: `Light${suffix}`, deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'], values: { current: ml, target } },
      );
    } else {
      const bs = find(node.values, CC.BinarySwitch, ep, 'currentValue');
      if (bs && at(CC.BinarySwitch)) {
        const target = find(node.values, CC.BinarySwitch, ep, 'targetValue') ?? { ...bs, property: 'targetValue' };
        const power = node.values.find((v) => v.commandClass === CC.Meter && (v.endpoint ?? 0) === ep && node.isPowerMeter?.(v));
        out.push({
          key: `ep${ep}:switch`,
          kind: 'switch',
          endpoint: ep,
          name: `Switch${suffix}`,
          deviceType: node.generic === 0x10 && power ? DeviceTypes.OnOffPlugInUnit.id : DeviceTypes.OnOffSwitch.id,
          capabilities: power ? ['onOff', 'electricalPowerMeasurement'] : ['onOff'],
          values: { current: bs, target, ...(power ? { power } : {}) },
        });
      }
    }
    for (const v of node.values.filter((x) => x.commandClass === CC.MultilevelSensor && (x.endpoint ?? 0) === ep)) {
      const t = SENSOR_TYPES[String(v.property)];
      if (!t || !at(CC.MultilevelSensor)) continue;
      if (t.capability === 'electricalPowerMeasurement' && out.some((f) => f.endpoint === ep && f.values.power)) continue;
      out.push({ key: `ep${ep}:sensor:${v.property}`, kind: 'sensor', endpoint: ep, name: `${t.name}${suffix}`, deviceType: t.deviceType, capabilities: [t.capability], values: { value: v } });
    }
    // Notifications (preferred) or legacy Binary Sensor
    const motion = find(node.values, CC.Notification, ep, 'Home Security', 'Motion sensor status') ?? find(node.values, CC.BinarySensor, ep, 'Motion');
    if (motion) out.push({ key: `ep${ep}:motion`, kind: 'motion', endpoint: ep, name: `Motion${suffix}`, deviceType: DeviceTypes.OccupancySensor.id, capabilities: ['occupancySensing'], values: { value: motion } });
    const door = find(node.values, CC.Notification, ep, 'Access Control', 'Door state (simple)') ?? find(node.values, CC.Notification, ep, 'Access Control', 'Door state') ?? find(node.values, CC.BinarySensor, ep, 'Door/Window');
    if (door) out.push({ key: `ep${ep}:contact`, kind: 'contact', endpoint: ep, name: `Contact${suffix}`, deviceType: DeviceTypes.ContactSensor.id, capabilities: ['booleanState'], values: { value: door } });
    const leak = find(node.values, CC.Notification, ep, 'Water Alarm', 'Sensor status') ?? find(node.values, CC.BinarySensor, ep, 'Water');
    if (leak) out.push({ key: `ep${ep}:leak`, kind: 'leak', endpoint: ep, name: `Leak${suffix}`, deviceType: DeviceTypes.LeakSensor.id, capabilities: ['booleanState'], values: { value: leak } });

    const mode = find(node.values, CC.ThermostatMode, ep, 'mode');
    if (mode) {
      const heat = find(node.values, CC.ThermostatSetpoint, ep, 'setpoint', 1);
      const cool = find(node.values, CC.ThermostatSetpoint, ep, 'setpoint', 2);
      const temp = find(node.values, CC.MultilevelSensor, ep, 'Air temperature');
      const state = find(node.values, CC.ThermostatOperatingState, ep, 'state');
      out.push({
        key: `ep${ep}:thermostat`,
        kind: 'thermostat',
        endpoint: ep,
        name: `Thermostat${suffix}`,
        deviceType: cool ? DeviceTypes.AirConditioner.id : DeviceTypes.Thermostat.id,
        capabilities: ['thermostat'],
        values: { mode, ...(heat ? { heat } : {}), ...(cool ? { cool } : {}), ...(temp ? { temp } : {}), ...(state ? { state } : {}) },
      });
    }
    const lock = find(node.values, CC.DoorLock, ep, 'currentMode');
    if (lock) out.push({ key: `ep${ep}:lock`, kind: 'lock', endpoint: ep, name: `Lock${suffix}`, deviceType: DeviceTypes.DoorLock.id, capabilities: ['doorLock'], values: { current: lock, target: find(node.values, CC.DoorLock, ep, 'targetMode') ?? { ...lock, property: 'targetMode' } } });
    if (ep === 0 && node.values.some((v) => v.commandClass === CC.CentralScene && v.property === 'scene')) {
      out.push({ key: 'scene', kind: 'scene', endpoint: 0, name: 'Button', deviceType: DeviceTypes.GenericSwitch.id, capabilities: ['genericSwitch'], values: {} });
    }
    const battery = find(node.values, CC.Battery, ep, 'level');
    if (battery && ep === 0) out.push({ key: 'battery', kind: 'battery', endpoint: 0, name: 'Battery', deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'], values: { value: battery } });
  }
  // A thermostat's own temperature sensor would duplicate the reading.
  return out.filter((f) => !(f.kind === 'sensor' && f.capabilities[0] === 'temperatureMeasurement' && out.some((t) => t.kind === 'thermostat' && t.endpoint === f.endpoint)));
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };

const same = (a: ValueId | undefined, b: ValueId) =>
  a !== undefined && a.commandClass === b.commandClass && (a.endpoint ?? 0) === (b.endpoint ?? 0) && a.property === b.property && (a.propertyKey ?? null) === (b.propertyKey ?? null);

/** A changed Z-Wave value → Livynq updates for the feature that owns it. */
export function valueToUpdates(feature: Feature, valueId: ValueId, value: unknown, unit?: string): Update[] {
  const v = feature.values;
  const num = typeof value === 'number' ? value : undefined;
  switch (feature.kind) {
    case 'switch':
      if (same(v.current, valueId) && typeof value === 'boolean') return [{ capability: 'onOff', attributes: { onOff: value } }];
      if (same(v.power, valueId) && num !== undefined) return [{ capability: 'electricalPowerMeasurement', attributes: { activePower: num } }];
      return [];
    case 'dimmer':
      if (!same(v.current, valueId) || num === undefined) return [];
      return num > 0
        ? [{ capability: 'onOff', attributes: { onOff: true } }, { capability: 'levelControl', attributes: { currentLevel: percentToLevel(Math.min(100, (num / 99) * 100)) } }]
        : [{ capability: 'onOff', attributes: { onOff: false } }];
    case 'cover':
      if (same(v.current, valueId) && num !== undefined) return [{ capability: 'windowCovering', attributes: { currentPosition: num >= 99 ? 100 : num, operationalStatus: 'stopped' } }];
      if (same(v.target, valueId) && num !== undefined) return [{ capability: 'windowCovering', attributes: { targetPosition: num >= 99 ? 100 : num } }];
      return [];
    case 'sensor': {
      if (!same(v.value, valueId) || num === undefined) return [];
      const cap = feature.capabilities[0]!;
      if (cap === 'temperatureMeasurement') return [{ capability: cap, attributes: { measuredValue: unit === '°F' ? Math.round(((num - 32) * 5) / 9 * 10) / 10 : num } }];
      if (cap === 'electricalPowerMeasurement') return [{ capability: cap, attributes: { activePower: num } }];
      return [{ capability: cap, attributes: { measuredValue: num } }];
    }
    case 'motion':
      if (!same(v.value, valueId)) return [];
      return [{ capability: 'occupancySensing', attributes: { occupied: typeof value === 'boolean' ? value : num === 8 || num === 7 } }];
    case 'contact':
      if (!same(v.value, valueId)) return [];
      // Notification: 22 open, 23 closed. Binary sensor: true = open. Matter BooleanState: true = closed.
      return [{ capability: 'booleanState', attributes: { stateValue: typeof value === 'boolean' ? !value : num === 23 } }];
    case 'leak':
      if (!same(v.value, valueId)) return [];
      return [{ capability: 'booleanState', attributes: { stateValue: typeof value === 'boolean' ? value : num !== undefined && num !== 0 } }];
    case 'battery':
      if (!same(v.value, valueId) || num === undefined) return [];
      return [{ capability: 'powerSource', attributes: { batPercentRemaining: num, batChargeLevelLow: num < 20 } }];
    case 'thermostat': {
      if (same(v.mode, valueId) && num !== undefined) {
        const mode = ({ 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto', 6: 'fan_only', 8: 'dry' } as Record<number, string>)[num];
        return mode ? [{ capability: 'thermostat', attributes: { systemMode: mode } }] : [];
      }
      if ((same(v.heat, valueId) || same(v.cool, valueId)) && num !== undefined) return [{ capability: 'thermostat', attributes: { targetTemperature: num } }];
      if (same(v.temp, valueId) && num !== undefined) return [{ capability: 'thermostat', attributes: { localTemperature: num } }];
      if (same(v.state, valueId) && num !== undefined) {
        const s = num === 1 || num === 4 || num === 5 ? 'heating' : num === 2 || num === 6 ? 'cooling' : num === 3 ? 'fan' : 'idle';
        return [{ capability: 'thermostat', attributes: { runningState: s } }];
      }
      return [];
    }
    case 'lock':
      if (!same(v.current, valueId) || num === undefined) return [];
      return [{ capability: 'doorLock', attributes: { lockState: num === 255 ? 'locked' : num === 0 ? 'unlocked' : 'unknown' } }];
    case 'scene':
      return [];
  }
}

/** Central Scene key attribute → button press. */
export function sceneToUpdate(sceneKey: string | number, keyAttribute: number): Update | undefined {
  const event = keyAttribute === 0 ? 'single' : keyAttribute === 1 ? 'release' : keyAttribute === 2 ? 'long' : keyAttribute === 3 ? 'double' : undefined;
  if (!event) return undefined;
  return { capability: 'genericSwitch', attributes: { lastEvent: event, lastEventAt: Date.now(), lastAction: `scene ${sceneKey} ${event}` } };
}

/** Livynq command → value writes. */
export function commandToWrites(feature: Feature, capability: string, command: string, params: Record<string, unknown>, state: { on?: boolean; supportedModes?: string }): { valueId: ValueId; value: unknown }[] {
  const v = feature.values;
  switch (`${feature.kind}:${capability}.${command}`) {
    case 'switch:onOff.on':
      return [{ valueId: v.target!, value: true }];
    case 'switch:onOff.off':
      return [{ valueId: v.target!, value: false }];
    case 'switch:onOff.toggle':
      return [{ valueId: v.target!, value: !state.on }];
    case 'dimmer:onOff.on':
      return [{ valueId: v.target!, value: 255 }]; // 255 = previous level
    case 'dimmer:onOff.off':
      return [{ valueId: v.target!, value: 0 }];
    case 'dimmer:onOff.toggle':
      return [{ valueId: v.target!, value: state.on ? 0 : 255 }];
    case 'dimmer:levelControl.moveToLevel':
      return [{ valueId: v.target!, value: Math.max(1, Math.min(99, Math.round((levelToPercent(Number(params.level)) / 100) * 99))) }];
    case 'cover:windowCovering.open':
      return [{ valueId: v.target!, value: 99 }];
    case 'cover:windowCovering.close':
      return [{ valueId: v.target!, value: 0 }];
    case 'cover:windowCovering.goToPosition':
      return [{ valueId: v.target!, value: Math.min(99, Math.round(Number(params.position))) }];
    case 'thermostat:thermostat.setSystemMode': {
      const value = ({ off: 0, heat: 1, cool: 2, auto: 3, fan_only: 6, dry: 8 } as Record<string, number>)[String(params.mode)];
      if (value === undefined) throw new Error(`Unsupported mode ${params.mode}`);
      return [{ valueId: v.mode!, value }];
    }
    case 'thermostat:thermostat.setTargetTemperature': {
      const setpoint = state.supportedModes !== undefined && v.cool && !v.heat ? v.cool : v.heat ?? v.cool;
      if (!setpoint) throw new Error('This thermostat has no setpoint');
      return [{ valueId: setpoint, value: Number(params.temperature) }];
    }
    case 'lock:doorLock.lock':
      return [{ valueId: v.target!, value: 255 }];
    case 'lock:doorLock.unlock':
      return [{ valueId: v.target!, value: 0 }];
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}

/** Commands the feature can execute (for handler registration). */
export function featureCommands(feature: Feature): Record<string, string[]> {
  switch (feature.kind) {
    case 'switch':
      return { onOff: ['on', 'off', 'toggle'] };
    case 'dimmer':
      return { onOff: ['on', 'off', 'toggle'], levelControl: ['moveToLevel'] };
    case 'cover':
      // Multilevel Switch "stop" needs Start/Stop Level Change; not supported for now.
      return { windowCovering: ['open', 'close', 'goToPosition'] };
    case 'thermostat':
      return { thermostat: ['setSystemMode', 'setTargetTemperature'] };
    case 'lock':
      return { doorLock: ['lock', 'unlock'] };
    default:
      return {};
  }
}
