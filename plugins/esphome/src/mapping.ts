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
    default:
      return undefined;
  }
}

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
  }
  return [];
}

/** Livynq command → ESPHome LightCommandRequest / SwitchCommandRequest fields. */
export function commandPayload(type: string, capability: string, command: string, params: Record<string, unknown>, current: { on?: boolean }): Record<string, unknown> {
  const transition = params.transitionTime === undefined ? {} : { transitionLength: Number(params.transitionTime) * 100 };
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
