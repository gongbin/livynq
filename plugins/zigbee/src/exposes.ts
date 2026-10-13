import {
  DeviceTypes,
  degreesToHue,
  hueToDegrees,
  percentToSat,
  satToPercent,
  type AttributeValue,
  type CapabilityId,
} from '@livynq/sdk';

/**
 * Maps zigbee-herdsman-converters "exposes" (the same device descriptions Zigbee2MQTT uses)
 * onto Livynq endpoints, and converter payloads / Livynq commands between the two models.
 */
export interface Expose {
  type: string;
  name?: string;
  property?: string;
  endpoint?: string;
  value_on?: unknown;
  value_off?: unknown;
  unit?: string;
  features?: Expose[];
}

export interface EndpointPlan {
  /** Stable key for ctx.endpointId(): "light", "light:l1", "numeric:temperature", ... */
  key: string;
  name?: string;
  deviceType: string;
  capabilities: CapabilityId[];
  /** Zigbee endpoint name (multi-endpoint devices), passed to toZigbee converters. */
  endpointName?: string;
  props: {
    state?: string;
    brightness?: string;
    colorTemp?: string;
    color?: { property: string; format: 'xy' | 'hs' };
    value?: string;
    valueOn?: unknown;
    valueOff?: unknown;
    colorTempRange?: [number, number];
  };
}

const NUMERIC: Record<string, { deviceType: string; capability: CapabilityId; label: string }> = {
  temperature: { deviceType: DeviceTypes.TemperatureSensor.id, capability: 'temperatureMeasurement', label: 'Temperature' },
  humidity: { deviceType: DeviceTypes.HumiditySensor.id, capability: 'relativeHumidityMeasurement', label: 'Humidity' },
  illuminance: { deviceType: DeviceTypes.LightSensor.id, capability: 'illuminanceMeasurement', label: 'Illuminance' },
  illuminance_lux: { deviceType: DeviceTypes.LightSensor.id, capability: 'illuminanceMeasurement', label: 'Illuminance' },
  battery: { deviceType: DeviceTypes.BatterySensor.id, capability: 'powerSource', label: 'Battery' },
  power: { deviceType: DeviceTypes.PowerSensor.id, capability: 'electricalPowerMeasurement', label: 'Power' },
};

const BINARY: Record<string, { deviceType: string; capability: CapabilityId; label: string }> = {
  occupancy: { deviceType: DeviceTypes.OccupancySensor.id, capability: 'occupancySensing', label: 'Occupancy' },
  presence: { deviceType: DeviceTypes.OccupancySensor.id, capability: 'occupancySensing', label: 'Presence' },
  contact: { deviceType: DeviceTypes.ContactSensor.id, capability: 'booleanState', label: 'Contact' },
  water_leak: { deviceType: DeviceTypes.LeakSensor.id, capability: 'booleanState', label: 'Water leak' },
};

const feature = (e: Expose, name: string) => e.features?.find((f) => f.name === name);

export function planEndpoints(exposes: Expose[], description = ''): EndpointPlan[] {
  const plans: EndpointPlan[] = [];
  const isPlug = /plug|socket|outlet/i.test(description);
  for (const e of exposes) {
    const suffix = e.endpoint ? `:${e.endpoint}` : '';
    if (e.type === 'light') {
      const state = feature(e, 'state');
      if (!state?.property) continue;
      const brightness = feature(e, 'brightness');
      const colorTemp = feature(e, 'color_temp') as (Expose & { value_min?: number; value_max?: number }) | undefined;
      const colorXy = feature(e, 'color_xy');
      const colorHs = feature(e, 'color_hs');
      const color = colorHs?.property ? { property: colorHs.property, format: 'hs' as const } : colorXy?.property ? { property: colorXy.property, format: 'xy' as const } : undefined;
      const deviceType = color
        ? DeviceTypes.ExtendedColorLight.id
        : colorTemp
          ? DeviceTypes.ColorTemperatureLight.id
          : brightness
            ? DeviceTypes.DimmableLight.id
            : DeviceTypes.OnOffLight.id;
      const capabilities: CapabilityId[] = ['onOff'];
      if (brightness || colorTemp || color) capabilities.push('levelControl');
      if (colorTemp || color) capabilities.push('colorControl');
      plans.push({
        key: `light${suffix}`,
        name: e.endpoint ? `Light ${e.endpoint}` : undefined,
        deviceType,
        capabilities,
        endpointName: e.endpoint,
        props: {
          state: state.property,
          brightness: brightness?.property,
          colorTemp: colorTemp?.property,
          color,
          valueOn: state.value_on ?? 'ON',
          valueOff: state.value_off ?? 'OFF',
          ...(colorTemp?.value_min !== undefined ? { colorTempRange: [colorTemp.value_min, colorTemp.value_max ?? 500] as [number, number] } : {}),
        },
      });
    } else if (e.type === 'switch') {
      const state = feature(e, 'state');
      if (!state?.property) continue;
      plans.push({
        key: `switch${suffix}`,
        name: e.endpoint ? `Switch ${e.endpoint}` : undefined,
        deviceType: isPlug ? DeviceTypes.OnOffPlugInUnit.id : DeviceTypes.OnOffSwitch.id,
        capabilities: ['onOff'],
        endpointName: e.endpoint,
        props: { state: state.property, valueOn: state.value_on ?? 'ON', valueOff: state.value_off ?? 'OFF' },
      });
    } else if (e.type === 'numeric' && e.name && NUMERIC[e.name] && e.property) {
      const m = NUMERIC[e.name]!;
      if (plans.some((p) => p.capabilities[0] === m.capability && p.endpointName === e.endpoint)) continue; // illuminance + illuminance_lux
      plans.push({ key: `numeric:${e.property}`, name: m.label, deviceType: m.deviceType, capabilities: [m.capability], endpointName: e.endpoint, props: { value: e.property } });
    } else if (e.type === 'binary' && e.name && BINARY[e.name] && e.property) {
      const m = BINARY[e.name]!;
      plans.push({ key: `binary:${e.property}`, name: m.label, deviceType: m.deviceType, capabilities: [m.capability], endpointName: e.endpoint, props: { value: e.property, valueOn: e.value_on ?? true, valueOff: e.value_off ?? false } });
    }
  }
  // Single-endpoint devices don't need endpoint names.
  if (plans.length === 1) delete plans[0]!.name;
  return plans;
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };

/** Converter output (e.g. { state: 'ON', brightness: 200, temperature: 21.5 }) → updates for one endpoint. */
export function payloadToUpdates(plan: EndpointPlan, payload: Record<string, unknown>): Update[] {
  const out: Update[] = [];
  const p = plan.props;
  const has = (prop: string | undefined): prop is string => prop !== undefined && payload[prop] !== undefined && payload[prop] !== null;
  if (plan.capabilities[0] === 'onOff' && has(p.state)) {
    const v = payload[p.state];
    if (v === p.valueOn || v === p.valueOff) out.push({ capability: 'onOff', attributes: { onOff: v === p.valueOn } });
  }
  if (plan.capabilities.includes('levelControl') && has(p.brightness)) {
    out.push({ capability: 'levelControl', attributes: { currentLevel: Math.min(254, Math.max(1, Math.round(Number(payload[p.brightness])))) } });
  }
  if (plan.capabilities.includes('colorControl')) {
    const color: Record<string, AttributeValue> = {};
    if (p.colorTempRange) Object.assign(color, { colorTempPhysicalMinMireds: p.colorTempRange[0], colorTempPhysicalMaxMireds: p.colorTempRange[1] });
    if (has(p.colorTemp)) color.colorTemperatureMireds = Math.round(Number(payload[p.colorTemp]));
    if (p.color && has(p.color.property)) {
      const c = payload[p.color.property] as Record<string, number>;
      const hs = c.hue !== undefined ? { h: c.hue, s: c.saturation ?? 0 } : c.x !== undefined ? xyToHs(c.x, c.y ?? 0) : undefined;
      if (hs) Object.assign(color, { currentHue: degreesToHue(hs.h), currentSaturation: percentToSat(hs.s) });
    }
    if (payload.color_mode === 'color_temp') color.colorMode = 'ct';
    else if (payload.color_mode === 'xy' || payload.color_mode === 'hs') color.colorMode = 'hs';
    if (Object.keys(color).length) out.push({ capability: 'colorControl', attributes: color });
  }
  if (p.value && has(p.value)) {
    const v = payload[p.value];
    switch (plan.capabilities[0]) {
      case 'temperatureMeasurement':
        out.push({ capability: 'temperatureMeasurement', attributes: { measuredValue: Number(v) } });
        break;
      case 'relativeHumidityMeasurement':
        out.push({ capability: 'relativeHumidityMeasurement', attributes: { measuredValue: Number(v) } });
        break;
      case 'illuminanceMeasurement':
        out.push({ capability: 'illuminanceMeasurement', attributes: { measuredValue: Number(v) } });
        break;
      case 'powerSource':
        out.push({ capability: 'powerSource', attributes: { batPercentRemaining: Number(v), batChargeLevelLow: Number(v) < 20 } });
        break;
      case 'electricalPowerMeasurement':
        out.push({ capability: 'electricalPowerMeasurement', attributes: { activePower: Number(v) } });
        break;
      case 'occupancySensing':
        out.push({ capability: 'occupancySensing', attributes: { occupied: v === p.valueOn } });
        break;
      case 'booleanState':
        // Raw values already match Matter BooleanState: contact=true means closed (Z2M exposes it with
        // value_on=false, "on" being the open/alarm state), water_leak=true means leak.
        out.push({ capability: 'booleanState', attributes: { stateValue: v === true } });
        break;
    }
  }
  return out;
}

/** Livynq command → toZigbee key/value (the same keys Zigbee2MQTT accepts on `<device>/set`). */
export function commandToZigbee(plan: EndpointPlan, capability: string, command: string, params: Record<string, unknown>, current: { on?: boolean }): { key: string; value: unknown; transition?: number } {
  const transition = params.transitionTime === undefined ? undefined : Number(params.transitionTime) / 10;
  const p = plan.props;
  switch (`${capability}.${command}`) {
    case 'onOff.on':
      return { key: 'state', value: p.valueOn ?? 'ON' };
    case 'onOff.off':
      return { key: 'state', value: p.valueOff ?? 'OFF' };
    case 'onOff.toggle':
      return { key: 'state', value: current.on ? (p.valueOff ?? 'OFF') : (p.valueOn ?? 'ON') };
    case 'levelControl.moveToLevel':
      return { key: 'brightness', value: Number(params.level), transition };
    case 'colorControl.moveToColorTemperature':
      return { key: 'color_temp', value: Number(params.colorTemperatureMireds), transition };
    case 'colorControl.moveToHueAndSaturation': {
      const h = hueToDegrees(Number(params.hue));
      const s = satToPercent(Number(params.saturation));
      return { key: 'color', value: p.color?.format === 'hs' ? { hue: h, saturation: s } : hsToXy(h, s), transition };
    }
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}

function xyToHs(x: number, y: number): { h: number; s: number } {
  if (y <= 0) return { h: 0, s: 0 };
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

function hsToXy(h: number, sPct: number): { x: number; y: number } {
  const s = sPct / 100;
  const xx = s * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - s;
  const [r1, g1, b1] = h < 60 ? [s, xx, 0] : h < 120 ? [xx, s, 0] : h < 180 ? [0, s, xx] : h < 240 ? [0, xx, s] : h < 300 ? [xx, 0, s] : [s, 0, xx];
  const [r, g, b] = [r1 + m, g1 + m, b1 + m];
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z || 1;
  return { x: Math.round((X / sum) * 10000) / 10000, y: Math.round((Y / sum) * 10000) / 10000 };
}
