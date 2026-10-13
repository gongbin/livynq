import { DeviceTypes, levelToPercent, percentToLevel, hueToDegrees, satToPercent, degreesToHue, percentToSat, type AttributeValue, type CapabilityId } from '@livynq/sdk';

/** Subset of the ESPHome entity config/state objects (protobuf `toObject()` shapes). */
export interface EsphomeEntityConfig {
  key: number;
  objectId: string;
  name: string;
  deviceClass?: string;
  unitOfMeasurement?: string;
  supportedColorModesList?: number[];
  minMireds?: number;
  maxMireds?: number;
  disabledByDefault?: boolean;
  // Cover
  supportsPosition?: boolean;
  supportsTilt?: boolean;
  supportsStop?: boolean;
  // Fan
  supportsSpeed?: boolean;
  supportedSpeedCount?: number;
  // Climate
  supportedModesList?: number[];
  supportsTwoPointTargetTemperature?: boolean;
  visualMinTemperature?: number;
  visualMaxTemperature?: number;
  // Lock
  requiresCode?: boolean;
}

export interface EndpointPlan {
  deviceType: string;
  capabilities: CapabilityId[];
}

// ColorMode is a bit set in ESPHome's api.proto.
const BRIGHTNESS = 2;
const COLOR_TEMPERATURE = 8;
const COLD_WARM_WHITE = 16;
const RGB = 32;

export function planEntity(type: string, config: EsphomeEntityConfig): EndpointPlan | undefined {
  if (config.disabledByDefault) return undefined;
  switch (type) {
    case 'Light': {
      const modes = config.supportedColorModesList ?? [];
      const any = (bit: number) => modes.some((m) => (m & bit) === bit);
      if (any(RGB)) return { deviceType: DeviceTypes.ExtendedColorLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] };
      if (any(COLOR_TEMPERATURE) || any(COLD_WARM_WHITE)) return { deviceType: DeviceTypes.ColorTemperatureLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] };
      if (any(BRIGHTNESS)) return { deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] };
      return { deviceType: DeviceTypes.OnOffLight.id, capabilities: ['onOff'] };
    }
    case 'Switch':
      return config.deviceClass === 'outlet'
        ? { deviceType: DeviceTypes.OnOffPlugInUnit.id, capabilities: ['onOff'] }
        : { deviceType: DeviceTypes.OnOffSwitch.id, capabilities: ['onOff'] };
    case 'Sensor':
      switch (config.deviceClass) {
        case 'temperature':
          return { deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] };
        case 'humidity':
          return { deviceType: DeviceTypes.HumiditySensor.id, capabilities: ['relativeHumidityMeasurement'] };
        case 'illuminance':
          return { deviceType: DeviceTypes.LightSensor.id, capabilities: ['illuminanceMeasurement'] };
        case 'battery':
          return { deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'] };
        case 'power':
          return { deviceType: DeviceTypes.PowerSensor.id, capabilities: ['electricalPowerMeasurement'] };
        default:
          return undefined;
      }
    case 'BinarySensor':
      switch (config.deviceClass) {
        case 'motion':
        case 'occupancy':
        case 'presence':
        case 'moving':
          return { deviceType: DeviceTypes.OccupancySensor.id, capabilities: ['occupancySensing'] };
        case 'door':
        case 'window':
        case 'opening':
        case 'garage_door':
          return { deviceType: DeviceTypes.ContactSensor.id, capabilities: ['booleanState'] };
        case 'moisture':
          return { deviceType: DeviceTypes.LeakSensor.id, capabilities: ['booleanState'] };
        default:
          return undefined;
      }
    case 'Cover':
      return {
        deviceType: config.deviceClass === 'garage' ? DeviceTypes.GarageDoor.id : config.deviceClass === 'gate' ? DeviceTypes.Gate.id : DeviceTypes.WindowCovering.id,
        capabilities: ['windowCovering'],
      };
    case 'Fan':
      return { deviceType: DeviceTypes.Fan.id, capabilities: ['onOff', 'fanControl'] };
    case 'Climate': {
      const modes = config.supportedModesList ?? [];
      return { deviceType: modes.includes(2) ? DeviceTypes.AirConditioner.id : DeviceTypes.Thermostat.id, capabilities: ['thermostat'] };
    }
    case 'Lock':
      return { deviceType: DeviceTypes.DoorLock.id, capabilities: ['doorLock'] };
    default:
      return undefined;
  }
}

// ClimateMode in api.proto: 0 off, 1 heat_cool, 2 cool, 3 heat, 4 fan_only, 5 dry, 6 auto
const CLIMATE_MODES: Record<number, string> = { 0: 'off', 1: 'auto', 2: 'cool', 3: 'heat', 4: 'fan_only', 5: 'dry', 6: 'auto' };
const CLIMATE_ACTIONS: Record<number, string> = { 2: 'cooling', 3: 'heating', 5: 'drying', 6: 'fan' };
const LOCK_STATES: Record<number, string> = { 1: 'locked', 2: 'unlocked', 3: 'jammed' };

/** Commands an entity accepts, per capability (for handler registration). */
export function entityCommands(type: string, plan: EndpointPlan, config: EsphomeEntityConfig): Record<string, string[]> {
  switch (type) {
    case 'Light':
    case 'Switch': {
      const out: Record<string, string[]> = { onOff: ['on', 'off', 'toggle'] };
      if (plan.capabilities.includes('levelControl')) out.levelControl = ['moveToLevel'];
      if (plan.capabilities.includes('colorControl')) out.colorControl = ['moveToColorTemperature', 'moveToHueAndSaturation'];
      return out;
    }
    case 'Cover':
      return {
        windowCovering: [
          'open',
          'close',
          ...(config.supportsStop !== false ? ['stop'] : []),
          ...(config.supportsPosition ? ['goToPosition'] : []),
          ...(config.supportsTilt ? ['goToTilt'] : []),
        ],
      };
    case 'Fan':
      return { onOff: ['on', 'off', 'toggle'], fanControl: ['setPercent', 'setMode'] };
    case 'Climate':
      return { thermostat: config.supportsTwoPointTargetTemperature ? ['setSystemMode', 'setTemperatureRange'] : ['setSystemMode', 'setTargetTemperature'] };
    case 'Lock':
      return { doorLock: ['lock', 'unlock'] };
  }
  return {};
}

const pct = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v) * 100)));
const fanPercent = (level: number, count: number) => (count > 0 ? Math.round((level / count) * 100) : 100);
const fanMode = (percent: number) => (percent === 0 ? 'off' : percent <= 34 ? 'low' : percent <= 67 ? 'medium' : 'high');

export type Update = { capability: string; attributes: Record<string, AttributeValue> };

/** ESPHome state message → Livynq attribute updates. */
export function stateToUpdates(type: string, plan: EndpointPlan, config: EsphomeEntityConfig, state: Record<string, unknown>): Update[] {
  if (state.missingState) return [];
  switch (type) {
    case 'Light': {
      const out: Update[] = [{ capability: 'onOff', attributes: { onOff: Boolean(state.state) } }];
      if (plan.capabilities.includes('levelControl') && typeof state.brightness === 'number') {
        out.push({ capability: 'levelControl', attributes: { currentLevel: percentToLevel(state.brightness * 100) } });
      }
      if (plan.capabilities.includes('colorControl')) {
        const color: Record<string, AttributeValue> = {
          colorTempPhysicalMinMireds: Math.round(config.minMireds ?? 153),
          colorTempPhysicalMaxMireds: Math.round(config.maxMireds ?? 500),
        };
        if (typeof state.colorTemperature === 'number' && state.colorTemperature > 0) color.colorTemperatureMireds = Math.round(state.colorTemperature);
        const mode = Number(state.colorMode ?? 0);
        if (plan.deviceType === DeviceTypes.ExtendedColorLight.id && (mode & RGB) === RGB && typeof state.red === 'number') {
          const { h, s } = rgbToHs(Number(state.red), Number(state.green), Number(state.blue));
          Object.assign(color, { currentHue: degreesToHue(h), currentSaturation: percentToSat(s), colorMode: 'hs' });
        } else if ((mode & COLOR_TEMPERATURE) === COLOR_TEMPERATURE || (mode & COLD_WARM_WHITE) === COLD_WARM_WHITE) {
          color.colorMode = 'ct';
        }
        out.push({ capability: 'colorControl', attributes: color });
      }
      return out;
    }
    case 'Switch':
      return [{ capability: 'onOff', attributes: { onOff: Boolean(state.state) } }];
    case 'Sensor': {
      const v = Number(state.state);
      if (!Number.isFinite(v)) return [];
      const value = config.unitOfMeasurement === '°F' ? Math.round(((v - 32) * 5) / 9 * 10) / 10 : Math.round(v * 100) / 100;
      switch (plan.capabilities[0]) {
        case 'temperatureMeasurement':
          return [{ capability: 'temperatureMeasurement', attributes: { measuredValue: value } }];
        case 'relativeHumidityMeasurement':
          return [{ capability: 'relativeHumidityMeasurement', attributes: { measuredValue: value } }];
        case 'illuminanceMeasurement':
          return [{ capability: 'illuminanceMeasurement', attributes: { measuredValue: value } }];
        case 'powerSource':
          return [{ capability: 'powerSource', attributes: { batPercentRemaining: value, batChargeLevelLow: value < 20 } }];
        case 'electricalPowerMeasurement':
          return [{ capability: 'electricalPowerMeasurement', attributes: { activePower: value } }];
      }
      return [];
    }
    case 'BinarySensor': {
      const on = Boolean(state.state);
      if (plan.capabilities[0] === 'occupancySensing') return [{ capability: 'occupancySensing', attributes: { occupied: on } }];
      // ESPHome/HA: door "on" = open. Matter BooleanState: true = contact closed.
      return [{ capability: 'booleanState', attributes: { stateValue: plan.deviceType === DeviceTypes.ContactSensor.id ? !on : on } }];
    }
    case 'Cover': {
      // position: 0 = closed, 1 = open (also without position support)
      const op = Number(state.currentOperation ?? 0);
      const attributes: Record<string, AttributeValue> = { currentPosition: pct(state.position), operationalStatus: op === 1 ? 'opening' : op === 2 ? 'closing' : 'stopped' };
      if (config.supportsTilt && typeof state.tilt === 'number') attributes.currentTilt = pct(state.tilt);
      return [{ capability: 'windowCovering', attributes }];
    }
    case 'Fan': {
      const on = Boolean(state.state);
      const percent = on ? (config.supportsSpeed ? fanPercent(Number(state.speedLevel ?? 0), config.supportedSpeedCount ?? 0) : 100) : 0;
      return [
        { capability: 'onOff', attributes: { onOff: on } },
        { capability: 'fanControl', attributes: { percentCurrent: percent, fanMode: !on ? 'off' : config.supportsSpeed ? fanMode(percent) : 'on' } },
      ];
    }
    case 'Climate': {
      const attributes: Record<string, AttributeValue> = {};
      const mode = CLIMATE_MODES[Number(state.mode ?? 0)];
      if (mode) attributes.systemMode = mode;
      const modes = [...new Set((config.supportedModesList ?? []).map((m) => CLIMATE_MODES[m]).filter(Boolean))];
      if (modes.length) attributes.supportedModes = modes.join(',');
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);
      if (num(state.currentTemperature) !== undefined) attributes.localTemperature = num(state.currentTemperature)!;
      if (config.supportsTwoPointTargetTemperature) {
        if (num(state.targetTemperatureLow) !== undefined) attributes.targetTemperatureLow = num(state.targetTemperatureLow)!;
        if (num(state.targetTemperatureHigh) !== undefined) attributes.targetTemperatureHigh = num(state.targetTemperatureHigh)!;
      } else if (num(state.targetTemperature) !== undefined) attributes.targetTemperature = num(state.targetTemperature)!;
      if (state.action !== undefined) attributes.runningState = CLIMATE_ACTIONS[Number(state.action)] ?? 'idle';
      if (config.visualMinTemperature) attributes.minSetpoint = config.visualMinTemperature;
      if (config.visualMaxTemperature) attributes.maxSetpoint = config.visualMaxTemperature;
      return [{ capability: 'thermostat', attributes }];
    }
    case 'Lock':
      return [{ capability: 'doorLock', attributes: { lockState: LOCK_STATES[Number(state.state ?? 0)] ?? 'unknown' } }];
  }
  return [];
}

/** Livynq command → ESPHome *CommandRequest fields. */
export function commandPayload(
  type: string,
  capability: string,
  command: string,
  params: Record<string, unknown>,
  current: { on?: boolean },
  config: EsphomeEntityConfig = { key: 0, objectId: '', name: '' },
): Record<string, unknown> {
  const transition = params.transitionTime === undefined ? {} : { transitionLength: Number(params.transitionTime) * 100 };
  switch (`${type}:${capability}.${command}`) {
    case 'Cover:windowCovering.open':
      return { position: 1 };
    case 'Cover:windowCovering.close':
      return { position: 0 };
    case 'Cover:windowCovering.stop':
      return { stop: true };
    case 'Cover:windowCovering.goToPosition':
      return { position: Math.max(0, Math.min(100, Number(params.position))) / 100 };
    case 'Cover:windowCovering.goToTilt':
      return { tilt: Math.max(0, Math.min(100, Number(params.tilt))) / 100 };
    case 'Fan:fanControl.setPercent':
    case 'Fan:fanControl.setMode': {
      const count = config.supportedSpeedCount ?? 0;
      const percent = command === 'setPercent' ? Number(params.percent) : ({ off: 0, low: 33, medium: 66, high: 100, on: 100, auto: 100 } as Record<string, number>)[String(params.mode)] ?? 100;
      if (percent <= 0) return { state: false };
      return config.supportsSpeed && count > 0 ? { state: true, speedLevel: Math.max(1, Math.round((percent / 100) * count)) } : { state: true };
    }
    case 'Climate:thermostat.setSystemMode': {
      const modes = config.supportedModesList ?? [];
      const want = String(params.mode);
      const value = want === 'auto' ? (modes.includes(6) || !modes.includes(1) ? 6 : 1) : Number(Object.entries(CLIMATE_MODES).find(([k, m]) => m === want && k !== '1')?.[0]);
      if (!Number.isFinite(value) || (modes.length && !modes.includes(value))) throw new Error(`This device does not support mode ${want}`);
      return { mode: value };
    }
    case 'Climate:thermostat.setTargetTemperature':
      return { targetTemperature: Number(params.temperature) };
    case 'Climate:thermostat.setTemperatureRange':
      return { targetTemperatureLow: Number(params.low), targetTemperatureHigh: Number(params.high) };
    case 'Lock:doorLock.lock':
    case 'Lock:doorLock.unlock':
      if (config.requiresCode) throw new Error('This lock requires a code; control it from ESPHome');
      return { command: command === 'lock' ? 1 : 0 };
  }
  if (capability === 'onOff') {
    const state = command === 'on' ? true : command === 'off' ? false : !current.on;
    return { state };
  }
  if (type !== 'Light') throw new Error(`${capability}.${command} is not supported by ${type}`);
  switch (`${capability}.${command}`) {
    case 'levelControl.moveToLevel':
      return { state: true, brightness: levelToPercent(Number(params.level)) / 100, ...transition };
    case 'colorControl.moveToColorTemperature':
      return { state: true, colorTemperature: Number(params.colorTemperatureMireds), ...transition };
    case 'colorControl.moveToHueAndSaturation': {
      const { r, g, b } = hsToRgb(hueToDegrees(Number(params.hue)), satToPercent(Number(params.saturation)));
      return { state: true, red: r, green: g, blue: b, ...transition };
    }
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}

export function rgbToHs(r: number, g: number, b: number): { h: number; s: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: Math.round((((h * 60) % 360) + 360) % 360), s: max === 0 ? 0 : Math.round((d / max) * 100) };
}

export function hsToRgb(h: number, sPct: number): { r: number; g: number; b: number } {
  const s = sPct / 100;
  const x = s * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - s;
  const [r, g, b] = h < 60 ? [s, x, 0] : h < 120 ? [x, s, 0] : h < 180 ? [0, s, x] : h < 240 ? [0, x, s] : h < 300 ? [x, 0, s] : [s, 0, x];
  const round = (v: number) => Math.round((v + m) * 1000) / 1000;
  return { r: round(r), g: round(g), b: round(b) };
}
