import { DeviceTypes, type CapabilityId } from '@livynq/model';

/** Home Assistant MQTT discovery abbreviations we understand (subset of homeassistant/components/mqtt/abbreviations.py). */
const ABBREVIATIONS: Record<string, string> = {
  avty: 'availability',
  avty_mode: 'availability_mode',
  avty_t: 'availability_topic',
  avty_tpl: 'availability_template',
  bri: 'brightness',
  bri_cmd_t: 'brightness_command_topic',
  bri_scl: 'brightness_scale',
  bri_stat_t: 'brightness_state_topic',
  bri_val_tpl: 'brightness_value_template',
  clr_temp_cmd_t: 'color_temp_command_topic',
  clr_temp_stat_t: 'color_temp_state_topic',
  clr_temp_val_tpl: 'color_temp_value_template',
  cmd_t: 'command_topic',
  cmd_tpl: 'command_template',
  dev: 'device',
  dev_cla: 'device_class',
  hs_cmd_t: 'hs_command_topic',
  hs_stat_t: 'hs_state_topic',
  hs_val_tpl: 'hs_value_template',
  max_mirs: 'max_mireds',
  min_mirs: 'min_mireds',
  obj_id: 'object_id',
  opt: 'optimistic',
  pl_avail: 'payload_available',
  pl_not_avail: 'payload_not_available',
  pl_off: 'payload_off',
  pl_on: 'payload_on',
  ret: 'retain',
  stat_off: 'state_off',
  stat_on: 'state_on',
  stat_t: 'state_topic',
  stat_val_tpl: 'state_value_template',
  sup_clrm: 'supported_color_modes',
  uniq_id: 'unique_id',
  unit_of_meas: 'unit_of_measurement',
  val_tpl: 'value_template',
  json_attr_t: 'json_attributes_topic',
  // cover
  pos_t: 'position_topic',
  pos_tpl: 'position_template',
  set_pos_t: 'set_position_topic',
  set_pos_tpl: 'set_position_template',
  pos_open: 'position_open',
  pos_clsd: 'position_closed',
  pl_open: 'payload_open',
  pl_cls: 'payload_close',
  pl_stop: 'payload_stop',
  stat_open: 'state_open',
  stat_clsd: 'state_closed',
  stat_opening: 'state_opening',
  stat_closing: 'state_closing',
  stat_stopped: 'state_stopped',
  tilt_cmd_t: 'tilt_command_topic',
  tilt_status_t: 'tilt_status_topic',
  tilt_status_tpl: 'tilt_status_template',
  tilt_cmd_tpl: 'tilt_command_template',
  // climate
  mode_cmd_t: 'mode_command_topic',
  mode_cmd_tpl: 'mode_command_template',
  mode_stat_t: 'mode_state_topic',
  mode_stat_tpl: 'mode_state_template',
  temp_cmd_t: 'temperature_command_topic',
  temp_cmd_tpl: 'temperature_command_template',
  temp_stat_t: 'temperature_state_topic',
  temp_stat_tpl: 'temperature_state_template',
  temp_lo_cmd_t: 'temperature_low_command_topic',
  temp_hi_cmd_t: 'temperature_high_command_topic',
  curr_temp_t: 'current_temperature_topic',
  curr_temp_tpl: 'current_temperature_template',
  act_t: 'action_topic',
  act_tpl: 'action_template',
  // fan
  pct_cmd_t: 'percentage_command_topic',
  pct_cmd_tpl: 'percentage_command_template',
  pct_stat_t: 'percentage_state_topic',
  pct_val_tpl: 'percentage_value_template',
  pr_mode_cmd_t: 'preset_mode_command_topic',
  pr_mode_cmd_tpl: 'preset_mode_command_template',
  pr_mode_stat_t: 'preset_mode_state_topic',
  pr_mode_val_tpl: 'preset_mode_value_template',
  pr_modes: 'preset_modes',
  spd_rng_min: 'speed_range_min',
  spd_rng_max: 'speed_range_max',
  // lock
  pl_lock: 'payload_lock',
  pl_unlk: 'payload_unlock',
  stat_locked: 'state_locked',
  stat_unlocked: 'state_unlocked',
  stat_jam: 'state_jammed',
  // device triggers / events
  atype: 'automation_type',
  t: 'topic',
  pl: 'payload',
  stype: 'subtype',
  evt_typ: 'event_types',
};

const DEVICE_ABBREVIATIONS: Record<string, string> = {
  ids: 'identifiers',
  cns: 'connections',
  mf: 'manufacturer',
  mdl: 'model',
  sw: 'sw_version',
  hw: 'hw_version',
  sa: 'suggested_area',
};

export type Component = 'light' | 'switch' | 'sensor' | 'binary_sensor' | 'cover' | 'climate' | 'fan' | 'lock' | 'device_automation' | 'event';
export const SUPPORTED_COMPONENTS: readonly Component[] = ['light', 'switch', 'sensor', 'binary_sensor', 'cover', 'climate', 'fan', 'lock', 'device_automation', 'event'];

export interface DiscoveryConfig {
  [key: string]: unknown;
  name?: string | null;
  unique_id?: string;
  device_class?: string;
  state_topic?: string;
  command_topic?: string;
  availability_topic?: string;
  availability?: { topic: string; payload_available?: string; payload_not_available?: string; value_template?: string }[];
  device?: { identifiers?: string[] | string; connections?: [string, string][]; name?: string; manufacturer?: string; model?: string; sw_version?: string; suggested_area?: string };
}

export interface ParsedTopic {
  component: string;
  nodeId?: string;
  objectId: string;
}

/** `<prefix>/<component>/[<node_id>/]<object_id>/config` */
export function parseDiscoveryTopic(prefix: string, topic: string): ParsedTopic | undefined {
  const parts = topic.split('/');
  const prefixParts = prefix.split('/');
  if (parts.at(-1) !== 'config' || prefixParts.some((p, i) => parts[i] !== p)) return undefined;
  const rest = parts.slice(prefixParts.length, -1);
  if (rest.length === 2) return { component: rest[0]!, objectId: rest[1]! };
  if (rest.length === 3) return { component: rest[0]!, nodeId: rest[1]!, objectId: rest[2]! };
  return undefined;
}

/** Expands abbreviations and the `~` base topic. */
export function normalizeConfig(raw: Record<string, unknown>): DiscoveryConfig {
  const base = typeof raw['~'] === 'string' ? (raw['~'] as string) : undefined;
  const expandTopic = (key: string, value: unknown) => {
    if (base && typeof value === 'string' && (key.endsWith('_topic') || key === 'topic')) {
      if (value.startsWith('~')) return base + value.slice(1);
      if (value.endsWith('~')) return value.slice(0, -1) + base;
    }
    return value;
  };
  const out: DiscoveryConfig = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '~') continue;
    const key = ABBREVIATIONS[k] ?? k;
    out[key] = expandTopic(key, v);
  }
  if (out.device && typeof out.device === 'object') {
    out.device = Object.fromEntries(Object.entries(out.device).map(([k, v]) => [DEVICE_ABBREVIATIONS[k] ?? k, v])) as DiscoveryConfig['device'];
  }
  if (Array.isArray(out.availability)) {
    out.availability = (out.availability as Record<string, unknown>[]).map((a) => {
      const entry = Object.fromEntries(Object.entries(a).map(([k, v]) => [k === 't' ? 'topic' : ABBREVIATIONS[k] ?? k, v]));
      return { ...entry, topic: expandTopic('topic', entry.topic) } as { topic: string };
    });
  }
  return out;
}

export interface EndpointPlan {
  deviceType: string;
  capabilities: CapabilityId[];
}

/** Maps an HA entity to a Livynq endpoint, or undefined when not supported yet. */
export function planEndpoint(component: Component, config: DiscoveryConfig): EndpointPlan | undefined {
  const deviceClass = config.device_class;
  switch (component) {
    case 'light': {
      const modes = lightColorModes(config);
      const hasColor = modes.some((m) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m));
      const hasCt = modes.includes('color_temp');
      const hasBrightness = hasColor || hasCt || modes.includes('brightness') || modes.includes('white');
      if (hasColor) return { deviceType: DeviceTypes.ExtendedColorLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] };
      if (hasCt) return { deviceType: DeviceTypes.ColorTemperatureLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] };
      if (hasBrightness) return { deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] };
      return { deviceType: DeviceTypes.OnOffLight.id, capabilities: ['onOff'] };
    }
    case 'switch':
      return deviceClass === 'outlet'
        ? { deviceType: DeviceTypes.OnOffPlugInUnit.id, capabilities: ['onOff'] }
        : { deviceType: DeviceTypes.OnOffSwitch.id, capabilities: ['onOff'] };
    case 'sensor':
      switch (deviceClass) {
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
    case 'cover':
      return {
        deviceType: deviceClass === 'garage' ? DeviceTypes.GarageDoor.id : deviceClass === 'gate' ? DeviceTypes.Gate.id : DeviceTypes.WindowCovering.id,
        capabilities: ['windowCovering'],
      };
    case 'climate': {
      const modes = Array.isArray(config.modes) ? (config.modes as string[]) : ['off', 'heat'];
      return { deviceType: modes.includes('cool') ? DeviceTypes.AirConditioner.id : DeviceTypes.Thermostat.id, capabilities: ['thermostat'] };
    }
    case 'fan':
      return { deviceType: DeviceTypes.Fan.id, capabilities: ['onOff', 'fanControl'] };
    case 'lock':
      return { deviceType: DeviceTypes.DoorLock.id, capabilities: ['doorLock'] };
    case 'device_automation':
      return config.automation_type === 'trigger' && config.topic ? { deviceType: DeviceTypes.GenericSwitch.id, capabilities: ['genericSwitch'] } : undefined;
    case 'event':
      return { deviceType: DeviceTypes.GenericSwitch.id, capabilities: ['genericSwitch'] };
    case 'binary_sensor':
      switch (deviceClass) {
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
  }
}

/** Color modes for both the `json` schema (supported_color_modes) and the default schema (per-feature topics). */
export function lightColorModes(config: DiscoveryConfig): string[] {
  if (Array.isArray(config.supported_color_modes)) return config.supported_color_modes as string[];
  if (config.schema === 'json') {
    const modes: string[] = [];
    if (config.brightness) modes.push('brightness');
    if (config.color_temp) modes.push('color_temp');
    if (config.hs) modes.push('hs');
    if (config.xy) modes.push('xy');
    return modes.length ? modes : ['onoff'];
  }
  const modes: string[] = [];
  if (config.brightness_command_topic) modes.push('brightness');
  if (config.color_temp_command_topic) modes.push('color_temp');
  if (config.hs_command_topic) modes.push('hs');
  return modes.length ? modes : ['onoff'];
}

/** Groups entities into physical devices the way Home Assistant does: by device identifiers. */
export function deviceKey(config: DiscoveryConfig, topic: ParsedTopic): string {
  const ids = config.device?.identifiers;
  const first = Array.isArray(ids) ? ids[0] : ids;
  if (first) return String(first);
  const connection = config.device?.connections?.[0];
  if (connection) return `${connection[0]}_${connection[1]}`;
  return config.unique_id ?? `${topic.nodeId ? `${topic.nodeId}_` : ''}${topic.objectId}`;
}
