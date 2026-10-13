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

export type Component = 'light' | 'switch' | 'sensor' | 'binary_sensor';
export const SUPPORTED_COMPONENTS: readonly Component[] = ['light', 'switch', 'sensor', 'binary_sensor'];

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
