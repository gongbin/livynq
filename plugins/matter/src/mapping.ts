import {
  DeviceTypes,
  degreesToHue,
  listDeviceTypes,
  percentToSat,
  type AttributeValue,
  type CapabilityId,
  type DeviceTypeDefinition,
} from '@livynq/sdk';

/**
 * Pure translation between Matter (device types + cluster attributes, as read from a commissioned
 * node) and the Livynq model. Cluster keys are lower-camel cluster names ("onOff", "levelControl").
 */
export type ClusterState = Record<string, Record<string, unknown>>;

export interface MatterEndpointSnapshot {
  number: number;
  deviceTypes: number[];
  clusters: ClusterState;
}

export interface EndpointPlan {
  deviceType: string;
  capabilities: CapabilityId[];
}

const CLUSTER_FOR: Partial<Record<CapabilityId, string>> = {
  onOff: 'onOff',
  levelControl: 'levelControl',
  colorControl: 'colorControl',
  temperatureMeasurement: 'temperatureMeasurement',
  relativeHumidityMeasurement: 'relativeHumidityMeasurement',
  illuminanceMeasurement: 'illuminanceMeasurement',
  occupancySensing: 'occupancySensing',
  booleanState: 'booleanState',
  powerSource: 'powerSource',
  electricalPowerMeasurement: 'electricalPowerMeasurement',
  windowCovering: 'windowCovering',
  thermostat: 'thermostat',
  fanControl: 'fanControl',
  doorLock: 'doorLock',
  genericSwitch: 'switch',
};

// Matter device types Livynq knows, more specific first. Dimmable plug (0x010B) is treated as a dimmable light.
const EXTRA: Record<number, DeviceTypeDefinition> = { 0x010b: DeviceTypes.DimmableLight };
const BY_MATTER = new Map<number, DeviceTypeDefinition>([
  ...listDeviceTypes()
    .filter((d) => d.matterDeviceType !== undefined)
    .map((d) => [d.matterDeviceType!, d] as [number, DeviceTypeDefinition]),
  ...Object.entries(EXTRA).map(([k, v]) => [Number(k), v] as [number, DeviceTypeDefinition]),
]);

export const AGGREGATOR = 0x000e;
export const BRIDGED_NODE = 0x0013;

/** Picks the Livynq device type for an endpoint and keeps only capabilities whose cluster is present. */
export function planEndpoint(ep: MatterEndpointSnapshot): EndpointPlan | undefined {
  for (const code of ep.deviceTypes) {
    const type = BY_MATTER.get(code);
    if (!type) continue;
    const present = (cap: CapabilityId) => {
      const cluster = CLUSTER_FOR[cap];
      return cluster !== undefined && cluster in ep.clusters;
    };
    // Matter fans have no OnOff cluster: on/off is fanMode (emulated below).
    const fanWithoutOnOff = type.id === DeviceTypes.Fan.id && 'fanControl' in ep.clusters && !('onOff' in ep.clusters);
    const has = (cap: CapabilityId) => present(cap) || (fanWithoutOnOff && cap === 'onOff');
    const capabilities = [...type.required, ...type.optional].filter(has);
    if (!type.required.every(has)) continue;
    return { deviceType: type.id, capabilities };
  }
  return undefined;
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : undefined);

/** Matter attribute value → Livynq updates. */
export function attributeToUpdates(plan: EndpointPlan, cluster: string, attribute: string, value: unknown, clusters: ClusterState): Update[] {
  const u = (capability: string, attributes: Record<string, AttributeValue>) => [{ capability, attributes }];
  if (value === null || value === undefined) return [];
  switch (`${cluster}.${attribute}`) {
    case 'onOff.onOff':
      return u('onOff', { onOff: Boolean(value) });
    case 'levelControl.currentLevel':
      return u('levelControl', { currentLevel: Math.max(1, Math.min(254, n(value) ?? 1)) });
    case 'colorControl.colorTemperatureMireds':
      return u('colorControl', { colorTemperatureMireds: n(value)! });
    case 'colorControl.colorTempPhysicalMinMireds':
      return u('colorControl', { colorTempPhysicalMinMireds: n(value)! });
    case 'colorControl.colorTempPhysicalMaxMireds':
      return u('colorControl', { colorTempPhysicalMaxMireds: n(value)! });
    case 'colorControl.currentHue':
      return u('colorControl', { currentHue: n(value)! });
    case 'colorControl.currentSaturation':
      return u('colorControl', { currentSaturation: n(value)! });
    case 'colorControl.currentX':
    case 'colorControl.currentY': {
      const c = clusters.colorControl ?? {};
      const x = (n(attribute === 'currentX' ? value : c.currentX) ?? 0) / 65536;
      const y = (n(attribute === 'currentY' ? value : c.currentY) ?? 0) / 65536;
      if (Number(c.colorMode) !== 1 || !y) return [];
      const hs = xyToHs(x, y);
      return u('colorControl', { currentHue: degreesToHue(hs.h), currentSaturation: percentToSat(hs.s) });
    }
    case 'colorControl.colorMode':
      // 0 hue/saturation, 1 xy (reported as hs), 2 color temperature
      return u('colorControl', { colorMode: Number(value) === 2 ? 'ct' : 'hs' });
    case 'temperatureMeasurement.measuredValue':
      return u('temperatureMeasurement', { measuredValue: Math.round(n(value)!) / 100 });
    case 'relativeHumidityMeasurement.measuredValue':
      return u('relativeHumidityMeasurement', { measuredValue: Math.round(n(value)!) / 100 });
    case 'illuminanceMeasurement.measuredValue': {
      const raw = n(value)!;
      return u('illuminanceMeasurement', { measuredValue: raw <= 0 ? 0 : Math.round(10 ** ((raw - 1) / 10000)) });
    }
    case 'occupancySensing.occupancy':
      return u('occupancySensing', { occupied: Boolean((value as { occupied?: boolean }).occupied) });
    case 'booleanState.stateValue':
      return u('booleanState', { stateValue: Boolean(value) });
    case 'powerSource.batPercentRemaining':
      return plan.capabilities.includes('powerSource') ? u('powerSource', { batPercentRemaining: Math.round(n(value)! / 2) }) : [];
    case 'powerSource.batChargeLevel':
      return plan.capabilities.includes('powerSource') ? u('powerSource', { batChargeLevelLow: Number(value) > 0 }) : [];
    case 'electricalPowerMeasurement.activePower':
      return u('electricalPowerMeasurement', { activePower: Math.round(n(value)! / 1000) });
    case 'windowCovering.currentPositionLiftPercent100ths':
      // Matter: percent closed. Livynq: 100 = open.
      return u('windowCovering', { currentPosition: Math.round(100 - n(value)! / 100) });
    case 'windowCovering.targetPositionLiftPercent100ths':
      return u('windowCovering', { targetPosition: Math.round(100 - n(value)! / 100) });
    case 'windowCovering.operationalStatus': {
      const g = Number((value as { global?: number }).global ?? 0);
      return u('windowCovering', { operationalStatus: g === 1 ? 'opening' : g === 2 ? 'closing' : 'stopped' });
    }
    case 'thermostat.localTemperature':
      return u('thermostat', { localTemperature: n(value)! / 100 });
    case 'thermostat.systemMode': {
      const mode = ({ 0: 'off', 1: 'auto', 3: 'cool', 4: 'heat', 7: 'fan_only', 8: 'dry' } as Record<number, string>)[Number(value)];
      if (!mode) return [];
      // The target shown follows the active mode.
      const t = clusters.thermostat ?? {};
      const target = mode === 'cool' ? t.occupiedCoolingSetpoint : t.occupiedHeatingSetpoint ?? t.occupiedCoolingSetpoint;
      return u('thermostat', { systemMode: mode, ...(n(target) !== undefined ? { targetTemperature: n(target)! / 100 } : {}) });
    }
    case 'thermostat.occupiedHeatingSetpoint':
    case 'thermostat.occupiedCoolingSetpoint': {
      const mode = Number((clusters.thermostat ?? {}).systemMode);
      const isCool = attribute === 'occupiedCoolingSetpoint';
      // Report the setpoint of the active mode (cooling in cool mode, heating otherwise).
      if ((mode === 3) !== isCool && 'occupiedHeatingSetpoint' in (clusters.thermostat ?? {}) && 'occupiedCoolingSetpoint' in (clusters.thermostat ?? {})) return [];
      return u('thermostat', { targetTemperature: n(value)! / 100 });
    }
    case 'thermostat.controlSequenceOfOperation': {
      const seq = Number(value);
      const heat = seq >= 2;
      const cool = seq <= 1 || seq >= 4;
      return u('thermostat', { supportedModes: ['off', ...(heat ? ['heat'] : []), ...(cool ? ['cool'] : []), ...(heat && cool ? ['auto'] : [])].join(',') });
    }
    case 'thermostat.thermostatRunningState': {
      const r = value as { heat?: boolean; cool?: boolean; fan?: boolean };
      return u('thermostat', { runningState: r.heat ? 'heating' : r.cool ? 'cooling' : r.fan ? 'fan' : 'idle' });
    }
    case 'fanControl.percentCurrent':
      return u('fanControl', { percentCurrent: n(value)! });
    case 'fanControl.fanMode': {
      const mode = ['off', 'low', 'medium', 'high', 'on', 'auto'][Number(value)];
      if (!mode) return [];
      return [
        { capability: 'fanControl', attributes: { fanMode: mode } },
        ...(!('onOff' in clusters) && plan.capabilities.includes('onOff') ? [{ capability: 'onOff', attributes: { onOff: mode !== 'off' } }] : []),
      ];
    }
    case 'doorLock.lockState':
      return u('doorLock', { lockState: Number(value) === 1 ? 'locked' : Number(value) === 2 ? 'unlocked' : 'unknown' });
  }
  return [];
}

/** Matter Switch cluster events → button presses. */
export function switchEventToUpdate(event: string): Update | undefined {
  const map: Record<string, string> = { shortRelease: 'single', initialPress: '', longPress: 'long', longRelease: 'release', multiPressComplete: 'double' };
  const e = map[event];
  if (!e) return undefined;
  return { capability: 'genericSwitch', attributes: { lastEvent: e, lastEventAt: Date.now(), lastAction: event } };
}

export type MatterAction =
  | { kind: 'command'; cluster: string; command: string; request?: Record<string, unknown>; timed?: boolean }
  | { kind: 'write'; cluster: string; attribute: string; value: unknown };

/** Livynq command → Matter command invocation or attribute write. */
export function commandToMatter(capability: string, command: string, params: Record<string, unknown>, clusters: ClusterState): MatterAction[] {
  const options = { optionsMask: {}, optionsOverride: {} };
  const transitionTime = params.transitionTime === undefined ? 0 : Number(params.transitionTime);
  if (capability === 'onOff' && !('onOff' in clusters) && 'fanControl' in clusters) {
    const on = command === 'on' || (command === 'toggle' && Number(clusters.fanControl!.fanMode ?? 0) === 0);
    return [{ kind: 'write', cluster: 'fanControl', attribute: 'fanMode', value: on ? 4 : 0 }];
  }
  switch (`${capability}.${command}`) {
    case 'onOff.on':
      return [{ kind: 'command', cluster: 'onOff', command: 'on' }];
    case 'onOff.off':
      return [{ kind: 'command', cluster: 'onOff', command: 'off' }];
    case 'onOff.toggle':
      return [{ kind: 'command', cluster: 'onOff', command: 'toggle' }];
    case 'levelControl.moveToLevel':
      return [{ kind: 'command', cluster: 'levelControl', command: 'moveToLevelWithOnOff', request: { level: Number(params.level), transitionTime, ...options } }];
    case 'colorControl.moveToColorTemperature':
      return [{ kind: 'command', cluster: 'colorControl', command: 'moveToColorTemperature', request: { colorTemperatureMireds: Number(params.colorTemperatureMireds), transitionTime, ...options } }];
    case 'colorControl.moveToHueAndSaturation':
      return [{ kind: 'command', cluster: 'colorControl', command: 'moveToHueAndSaturation', request: { hue: Number(params.hue), saturation: Number(params.saturation), transitionTime, ...options } }];
    case 'windowCovering.open':
      return [{ kind: 'command', cluster: 'windowCovering', command: 'upOrOpen' }];
    case 'windowCovering.close':
      return [{ kind: 'command', cluster: 'windowCovering', command: 'downOrClose' }];
    case 'windowCovering.stop':
      return [{ kind: 'command', cluster: 'windowCovering', command: 'stopMotion' }];
    case 'windowCovering.goToPosition':
      return [{ kind: 'command', cluster: 'windowCovering', command: 'goToLiftPercentage', request: { liftPercent100thsValue: Math.round((100 - Number(params.position)) * 100) } }];
    case 'thermostat.setSystemMode': {
      const value = ({ off: 0, auto: 1, cool: 3, heat: 4, fan_only: 7, dry: 8 } as Record<string, number>)[String(params.mode)];
      if (value === undefined) throw new Error(`Unsupported mode ${params.mode}`);
      return [{ kind: 'write', cluster: 'thermostat', attribute: 'systemMode', value }];
    }
    case 'thermostat.setTargetTemperature': {
      const t = clusters.thermostat ?? {};
      const cool = Number(t.systemMode) === 3 || !('occupiedHeatingSetpoint' in t);
      return [{ kind: 'write', cluster: 'thermostat', attribute: cool ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint', value: Math.round(Number(params.temperature) * 100) }];
    }
    case 'thermostat.setTemperatureRange':
      return [
        { kind: 'write', cluster: 'thermostat', attribute: 'occupiedHeatingSetpoint', value: Math.round(Number(params.low) * 100) },
        { kind: 'write', cluster: 'thermostat', attribute: 'occupiedCoolingSetpoint', value: Math.round(Number(params.high) * 100) },
      ];
    case 'fanControl.setPercent':
      return [{ kind: 'write', cluster: 'fanControl', attribute: 'percentSetting', value: Number(params.percent) }];
    case 'fanControl.setMode': {
      const value = ['off', 'low', 'medium', 'high', 'on', 'auto'].indexOf(String(params.mode));
      if (value < 0) throw new Error(`Unsupported fan mode ${params.mode}`);
      return [{ kind: 'write', cluster: 'fanControl', attribute: 'fanMode', value }];
    }
    case 'doorLock.lock':
      return [{ kind: 'command', cluster: 'doorLock', command: 'lockDoor', request: {}, timed: true }];
    case 'doorLock.unlock':
      return [{ kind: 'command', cluster: 'doorLock', command: 'unlockDoor', request: {}, timed: true }];
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}

function xyToHs(x: number, y: number): { h: number; s: number } {
  const X = x / y;
  const Z = (1 - x - y) / y;
  let r = X * 1.656492 - 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b, 1e-9);
  [r, g, b] = [r / max, g / max, b / max].map((c) => Math.max(0, c)) as [number, number, number];
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round((((h * 60) % 360) + 360) % 360), s: Math.round((d / mx) * 100) };
}
