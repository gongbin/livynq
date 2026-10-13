import {
  DeviceTypes,
  degreesToHue,
  hueToDegrees,
  kelvinToMireds,
  levelToPercent,
  miredsToKelvin,
  percentToLevel,
  percentToSat,
  satToPercent,
  type AttributeValue,
  type CapabilityId,
} from '@livynq/sdk';

/** Home Assistant state object (subset). */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface EndpointPlan {
  deviceType: string;
  capabilities: CapabilityId[];
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };

const SENSOR_TYPES: Record<string, { deviceType: string; capability: CapabilityId }> = {
  temperature: { deviceType: DeviceTypes.TemperatureSensor.id, capability: 'temperatureMeasurement' },
  humidity: { deviceType: DeviceTypes.HumiditySensor.id, capability: 'relativeHumidityMeasurement' },
  illuminance: { deviceType: DeviceTypes.LightSensor.id, capability: 'illuminanceMeasurement' },
  battery: { deviceType: DeviceTypes.BatterySensor.id, capability: 'powerSource' },
  power: { deviceType: DeviceTypes.PowerSensor.id, capability: 'electricalPowerMeasurement' },
};

export const SUPPORTED_DOMAINS = ['light', 'switch', 'input_boolean', 'cover', 'climate', 'fan', 'lock', 'sensor', 'binary_sensor', 'event'];

export function planEntity(s: HaState): EndpointPlan | undefined {
  const domain = s.entity_id.split('.')[0]!;
  const a = s.attributes;
  const dc = typeof a.device_class === 'string' ? a.device_class : undefined;
  switch (domain) {
    case 'light': {
      const modes = Array.isArray(a.supported_color_modes) ? (a.supported_color_modes as string[]) : ['onoff'];
      if (modes.some((m) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m))) return { deviceType: DeviceTypes.ExtendedColorLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] };
      if (modes.includes('color_temp')) return { deviceType: DeviceTypes.ColorTemperatureLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] };
      if (modes.some((m) => m !== 'onoff')) return { deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] };
      return { deviceType: DeviceTypes.OnOffLight.id, capabilities: ['onOff'] };
    }
    case 'switch':
    case 'input_boolean':
      return { deviceType: dc === 'outlet' ? DeviceTypes.OnOffPlugInUnit.id : DeviceTypes.OnOffSwitch.id, capabilities: ['onOff'] };
    case 'cover':
      return { deviceType: dc === 'garage' ? DeviceTypes.GarageDoor.id : dc === 'gate' ? DeviceTypes.Gate.id : DeviceTypes.WindowCovering.id, capabilities: ['windowCovering'] };
    case 'climate': {
      const modes = Array.isArray(a.hvac_modes) ? (a.hvac_modes as string[]) : [];
      return { deviceType: modes.includes('cool') ? DeviceTypes.AirConditioner.id : DeviceTypes.Thermostat.id, capabilities: ['thermostat'] };
    }
    case 'fan':
      return { deviceType: DeviceTypes.Fan.id, capabilities: ['onOff', 'fanControl'] };
    case 'lock':
      return { deviceType: DeviceTypes.DoorLock.id, capabilities: ['doorLock'] };
    case 'event':
      return { deviceType: DeviceTypes.GenericSwitch.id, capabilities: ['genericSwitch'] };
    case 'sensor':
      return dc && SENSOR_TYPES[dc] ? { deviceType: SENSOR_TYPES[dc]!.deviceType, capabilities: [SENSOR_TYPES[dc]!.capability] } : undefined;
    case 'binary_sensor':
      if (['motion', 'occupancy', 'presence', 'moving'].includes(dc ?? '')) return { deviceType: DeviceTypes.OccupancySensor.id, capabilities: ['occupancySensing'] };
      if (['door', 'window', 'opening', 'garage_door'].includes(dc ?? '')) return { deviceType: DeviceTypes.ContactSensor.id, capabilities: ['booleanState'] };
      if (dc === 'moisture') return { deviceType: DeviceTypes.LeakSensor.id, capabilities: ['booleanState'] };
      return undefined;
  }
  return undefined;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** HA state → Livynq attribute updates. Returns [] for unavailable/unknown states. */
export function stateToUpdates(plan: EndpointPlan, s: HaState): Update[] {
  if (s.state === 'unavailable' || s.state === 'unknown') return [];
  const a = s.attributes;
  switch (plan.capabilities[0]) {
    case 'onOff': {
      const out: Update[] = [{ capability: 'onOff', attributes: { onOff: s.state === 'on' } }];
      if (plan.capabilities.includes('levelControl') && num(a.brightness) !== undefined) {
        out.push({ capability: 'levelControl', attributes: { currentLevel: percentToLevel((num(a.brightness)! / 255) * 100) } });
      }
      if (plan.capabilities.includes('colorControl')) {
        const color: Record<string, AttributeValue> = {};
        const minK = num(a.min_color_temp_kelvin);
        const maxK = num(a.max_color_temp_kelvin);
        if (minK && maxK) Object.assign(color, { colorTempPhysicalMinMireds: kelvinToMireds(maxK), colorTempPhysicalMaxMireds: kelvinToMireds(minK) });
        if (num(a.color_temp_kelvin)) color.colorTemperatureMireds = kelvinToMireds(num(a.color_temp_kelvin)!);
        if (Array.isArray(a.hs_color)) Object.assign(color, { currentHue: degreesToHue(Number(a.hs_color[0])), currentSaturation: percentToSat(Number(a.hs_color[1])) });
        if (a.color_mode === 'color_temp') color.colorMode = 'ct';
        else if (typeof a.color_mode === 'string' && ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(a.color_mode)) color.colorMode = 'hs';
        if (Object.keys(color).length) out.push({ capability: 'colorControl', attributes: color });
      }
      if (plan.capabilities.includes('fanControl')) {
        const f: Record<string, AttributeValue> = {};
        if (num(a.percentage) !== undefined) f.percentCurrent = num(a.percentage)!;
        if (typeof a.preset_mode === 'string' && ['off', 'low', 'medium', 'high', 'on', 'auto'].includes(a.preset_mode)) f.fanMode = a.preset_mode;
        if (Object.keys(f).length) out.push({ capability: 'fanControl', attributes: f });
      }
      return out;
    }
    case 'windowCovering': {
      const status = s.state === 'opening' || s.state === 'closing' ? s.state : 'stopped';
      const position = num(a.current_position) ?? (s.state === 'open' ? 100 : s.state === 'closed' ? 0 : undefined);
      return [{ capability: 'windowCovering', attributes: { operationalStatus: status, ...(position !== undefined ? { currentPosition: position } : {}), ...(num(a.current_tilt_position) !== undefined ? { currentTilt: num(a.current_tilt_position)! } : {}) } }];
    }
    case 'thermostat': {
      const t: Record<string, AttributeValue> = { systemMode: s.state === 'heat_cool' ? 'auto' : s.state };
      if (Array.isArray(a.hvac_modes)) t.supportedModes = (a.hvac_modes as string[]).map((m) => (m === 'heat_cool' ? 'auto' : m)).filter((m) => ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'].includes(m)).join(',');
      if (num(a.current_temperature) !== undefined) t.localTemperature = num(a.current_temperature)!;
      if (num(a.temperature) !== undefined) t.targetTemperature = num(a.temperature)!;
      if (num(a.target_temp_low) !== undefined) t.targetTemperatureLow = num(a.target_temp_low)!;
      if (num(a.target_temp_high) !== undefined) t.targetTemperatureHigh = num(a.target_temp_high)!;
      if (num(a.min_temp) !== undefined) t.minSetpoint = num(a.min_temp)!;
      if (num(a.max_temp) !== undefined) t.maxSetpoint = num(a.max_temp)!;
      const action = a.hvac_action;
      if (typeof action === 'string') t.runningState = ({ heating: 'heating', cooling: 'cooling', drying: 'drying', fan: 'fan' } as Record<string, string>)[action] ?? 'idle';
      if (!['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'].includes(String(t.systemMode))) delete t.systemMode;
      return [{ capability: 'thermostat', attributes: t }];
    }
    case 'doorLock':
      return [{ capability: 'doorLock', attributes: { lockState: s.state === 'locked' || s.state === 'unlocked' || s.state === 'jammed' ? s.state : 'unknown' } }];
    case 'genericSwitch': {
      const type = typeof a.event_type === 'string' ? a.event_type : undefined;
      const at = Date.parse(s.state);
      if (!type || !Number.isFinite(at)) return [];
      const lastEvent = /release/.test(type) ? 'release' : /double/.test(type) ? 'double' : /long|hold/.test(type) ? 'long' : 'single';
      return [{ capability: 'genericSwitch', attributes: { lastEvent, lastEventAt: at, lastAction: type } }];
    }
    case 'occupancySensing':
      return [{ capability: 'occupancySensing', attributes: { occupied: s.state === 'on' } }];
    case 'booleanState':
      // HA door "on" = open; Matter BooleanState true = contact closed. Leak: on = leak.
      return [{ capability: 'booleanState', attributes: { stateValue: plan.deviceType === DeviceTypes.ContactSensor.id ? s.state === 'off' : s.state === 'on' } }];
    default: {
      const v = num(s.state);
      if (v === undefined) return [];
      const capability = plan.capabilities[0]!;
      if (capability === 'powerSource') return [{ capability, attributes: { batPercentRemaining: v, batChargeLevelLow: v < 20 } }];
      if (capability === 'electricalPowerMeasurement') return [{ capability, attributes: { activePower: v } }];
      const temp = capability === 'temperatureMeasurement' && a.unit_of_measurement === '°F' ? Math.round(((v - 32) * 5) / 9 * 10) / 10 : v;
      return [{ capability, attributes: { measuredValue: temp } }];
    }
  }
}

export interface ServiceCall {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
}

/** Livynq command → HA service call for the entity. */
export function commandToService(entityId: string, capability: string, command: string, params: Record<string, unknown>, current: { on?: boolean }): ServiceCall {
  const domain = entityId.split('.')[0]!;
  const transition = params.transitionTime === undefined ? {} : { transition: Number(params.transitionTime) / 10 };
  switch (`${capability}.${command}`) {
    case 'onOff.on':
      return { domain: domain === 'input_boolean' ? 'input_boolean' : domain, service: 'turn_on' };
    case 'onOff.off':
      return { domain, service: 'turn_off' };
    case 'onOff.toggle':
      return { domain, service: current.on ? 'turn_off' : 'turn_on' };
    case 'levelControl.moveToLevel':
      return { domain: 'light', service: 'turn_on', data: { brightness_pct: levelToPercent(Number(params.level)), ...transition } };
    case 'colorControl.moveToColorTemperature':
      return { domain: 'light', service: 'turn_on', data: { color_temp_kelvin: miredsToKelvin(Number(params.colorTemperatureMireds)), ...transition } };
    case 'colorControl.moveToHueAndSaturation':
      return { domain: 'light', service: 'turn_on', data: { hs_color: [hueToDegrees(Number(params.hue)), satToPercent(Number(params.saturation))], ...transition } };
    case 'windowCovering.open':
      return { domain: 'cover', service: 'open_cover' };
    case 'windowCovering.close':
      return { domain: 'cover', service: 'close_cover' };
    case 'windowCovering.stop':
      return { domain: 'cover', service: 'stop_cover' };
    case 'windowCovering.goToPosition':
      return { domain: 'cover', service: 'set_cover_position', data: { position: Number(params.position) } };
    case 'windowCovering.goToTilt':
      return { domain: 'cover', service: 'set_cover_tilt_position', data: { tilt_position: Number(params.tilt) } };
    case 'thermostat.setSystemMode':
      return { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: params.mode } };
    case 'thermostat.setTargetTemperature':
      return { domain: 'climate', service: 'set_temperature', data: { temperature: Number(params.temperature) } };
    case 'thermostat.setTemperatureRange':
      return { domain: 'climate', service: 'set_temperature', data: { target_temp_low: Number(params.low), target_temp_high: Number(params.high) } };
    case 'fanControl.setPercent':
      return { domain: 'fan', service: 'set_percentage', data: { percentage: Number(params.percent) } };
    case 'fanControl.setMode':
      return { domain: 'fan', service: 'set_preset_mode', data: { preset_mode: String(params.mode) } };
    case 'doorLock.lock':
      return { domain: 'lock', service: 'lock' };
    case 'doorLock.unlock':
      return { domain: 'lock', service: 'unlock' };
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}
