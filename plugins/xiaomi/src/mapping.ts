import { DeviceTypes, clamp, degreesToHue, hueToDegrees, kelvinToMireds, levelToPercent, miredsToKelvin, percentToLevel, percentToSat, satToPercent, type AttributeValue, type CapabilityId } from '@livynq/sdk';
import { urnName, type DeviceSpec, type SpecProperty, type SpecService } from './spec.ts';

/**
 * MIoT services → Livynq endpoints. Each feature remembers which (siid, piid) pairs it reads and
 * writes; values travel as get_properties / set_properties over miIO or the cloud.
 */

export interface PropRef {
  siid: number;
  piid: number;
  format: string;
  writable: boolean;
  range?: [number, number, number];
  list?: { value: number; description: string }[];
  unit?: string;
}

export type FeatureKind = 'light' | 'switch' | 'outlet' | 'cover' | 'fan' | 'climate' | 'temperature' | 'humidity' | 'battery';

export interface Feature {
  /** "light:2" (kind + service iid); stable, used for endpoint ids */
  key: string;
  kind: FeatureKind;
  deviceType: string;
  capabilities: CapabilityId[];
  name?: string;
  props: Record<string, PropRef>;
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };
export type PropWrite = { siid: number; piid: number; value: unknown };

const ref = (s: SpecService, p: SpecProperty): PropRef => ({
  siid: s.iid,
  piid: p.iid,
  format: p.format,
  writable: p.access.includes('write'),
  ...(p['value-range'] ? { range: p['value-range'] } : {}),
  ...(p['value-list'] ? { list: p['value-list'] } : {}),
  ...(p.unit ? { unit: p.unit } : {}),
});

function props(s: SpecService): Record<string, PropRef> {
  const out: Record<string, PropRef> = {};
  for (const p of s.properties ?? []) {
    const name = urnName(p.type);
    if (name && !out[name]) out[name] = ref(s, p);
  }
  return out;
}

const pick = (all: Record<string, PropRef>, names: Record<string, string>) => {
  const out: Record<string, PropRef> = {};
  for (const [role, name] of Object.entries(names)) if (all[name]) out[role] = all[name];
  return out;
};

/** Finds a value-list entry by description words, e.g. find(list, 'cool') */
const findEnum = (p: PropRef | undefined, ...words: string[]) => p?.list?.find((e) => words.some((w) => e.description.toLowerCase().replace(/[^a-z]/g, '').includes(w)))?.value;

export function planFeatures(spec: DeviceSpec): Feature[] {
  const deviceKind = urnName(spec.type);
  const out: Feature[] = [];
  const env: Record<string, PropRef> = {};
  for (const s of spec.services) {
    const kind = urnName(s.type);
    const all = props(s);
    const name = s.description;
    switch (kind) {
      case 'light': {
        const p = pick(all, { on: 'on', brightness: 'brightness', ct: 'color-temperature', color: 'color' });
        if (!p.on) break;
        const caps: CapabilityId[] = ['onOff'];
        if (p.brightness) caps.push('levelControl');
        if (p.ct || p.color) caps.push('colorControl');
        const deviceType = p.color ? DeviceTypes.ExtendedColorLight.id : p.ct && p.brightness ? DeviceTypes.ColorTemperatureLight.id : p.brightness ? DeviceTypes.DimmableLight.id : DeviceTypes.OnOffLight.id;
        out.push({ key: `light:${s.iid}`, kind: 'light', deviceType, capabilities: caps, name, props: p });
        break;
      }
      case 'switch':
      case 'outlet': {
        const p = pick(all, { on: 'on', power: 'electric-power' });
        if (!p.on) break;
        const plug = kind === 'outlet' || deviceKind === 'outlet';
        out.push({
          key: `${plug ? 'outlet' : 'switch'}:${s.iid}`,
          kind: plug ? 'outlet' : 'switch',
          deviceType: plug ? DeviceTypes.OnOffPlugInUnit.id : DeviceTypes.OnOffSwitch.id,
          capabilities: p.power ? ['onOff', 'electricalPowerMeasurement'] : ['onOff'],
          name,
          props: p,
        });
        break;
      }
      case 'curtain':
      case 'window-opener':
      case 'airer': {
        const p = pick(all, { motor: 'motor-control', current: 'current-position', target: 'target-position' });
        if (!p.motor && !p.target) break;
        out.push({ key: `cover:${s.iid}`, kind: 'cover', deviceType: DeviceTypes.WindowCovering.id, capabilities: ['windowCovering'], name, props: p });
        break;
      }
      case 'fan':
      case 'air-purifier':
      case 'air-fresh': {
        const p = pick(all, { on: 'on', level: 'fan-level', mode: 'mode', speed: 'speed-level' });
        if (!p.on) break;
        out.push({ key: `fan:${s.iid}`, kind: 'fan', deviceType: DeviceTypes.Fan.id, capabilities: ['onOff', 'fanControl'], name, props: p });
        break;
      }
      case 'air-conditioner':
      case 'heater':
      case 'thermostat': {
        const p = pick(all, { on: 'on', mode: 'mode', target: 'target-temperature', temperature: 'temperature' });
        if (!p.on && !p.target) break;
        out.push({
          key: `climate:${s.iid}`,
          kind: 'climate',
          deviceType: kind === 'air-conditioner' ? DeviceTypes.AirConditioner.id : DeviceTypes.Thermostat.id,
          capabilities: ['thermostat'],
          name,
          props: { ...p, ...(kind === 'heater' ? { heaterOnly: p.on! } : {}) },
        });
        break;
      }
      case 'temperature-humidity-sensor':
      case 'environment': {
        Object.assign(env, pick(all, { temperature: 'temperature', humidity: 'relative-humidity' }));
        break;
      }
      case 'battery': {
        const p = pick(all, { level: 'battery-level' });
        if (p.level) out.push({ key: `battery:${s.iid}`, kind: 'battery', deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'], props: p });
        break;
      }
    }
  }
  // An air conditioner's room temperature lives in its "environment" service.
  const climate = out.find((f) => f.kind === 'climate');
  if (climate && env.temperature && !climate.props.temperature) climate.props.temperature = env.temperature;
  else if (env.temperature) out.push({ key: `temperature:${env.temperature.siid}`, kind: 'temperature', deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'], props: { value: env.temperature } });
  if (env.humidity) out.push({ key: `humidity:${env.humidity.siid}`, kind: 'humidity', deviceType: DeviceTypes.HumiditySensor.id, capabilities: ['relativeHumidityMeasurement'], props: { value: env.humidity } });
  // Name channels only when there are several of a kind.
  for (const f of out) if (out.filter((o) => o.kind === f.kind).length < 2) delete f.name;
  return out;
}

/** Every (siid, piid) a feature reads. */
export function readRefs(f: Feature): PropRef[] {
  return Object.values(f.props).filter((p, i, a) => a.findIndex((q) => q.siid === p.siid && q.piid === p.piid) === i);
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const levels = (p: PropRef): number[] => (p.list ? p.list.map((e) => e.value) : p.range ? Array.from({ length: Math.floor((p.range[1] - p.range[0]) / (p.range[2] || 1)) + 1 }, (_, i) => p.range![0] + i * (p.range![2] || 1)) : []);

function rgbToHs(rgb: number): { h: number; s: number } {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round((((h * 60) % 360) + 360) % 360), s: mx === 0 ? 0 : Math.round((d / mx) * 100) };
}

function hsToRgb(hDeg: number, sPct: number): number {
  const s = sPct / 100;
  const k = (n: number) => (n + hDeg / 60) % 6;
  const f = (n: number) => 1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return (Math.round(f(5) * 255) << 16) | (Math.round(f(3) * 255) << 8) | Math.round(f(1) * 255);
}

/** Values by "siid.piid" → Livynq updates. Missing values are simply not reported. */
export function valuesToUpdates(f: Feature, values: Map<string, unknown>): Update[] {
  const get = (role: string) => {
    const p = f.props[role];
    return p ? values.get(`${p.siid}.${p.piid}`) : undefined;
  };
  const out: Update[] = [];
  const on = get('on');
  switch (f.kind) {
    case 'light': {
      if (typeof on === 'boolean') out.push({ capability: 'onOff', attributes: { onOff: on } });
      const bri = num(get('brightness'));
      if (bri !== undefined) out.push({ capability: 'levelControl', attributes: { currentLevel: percentToLevel(bri) } });
      const color: Record<string, AttributeValue> = {};
      const k = num(get('ct'));
      if (k !== undefined && k > 0) color.colorTemperatureMireds = clamp(kelvinToMireds(k), 50, 1000);
      const ct = f.props.ct?.range;
      if (ct) {
        color.colorTempPhysicalMinMireds = clamp(kelvinToMireds(ct[1]), 50, 1000);
        color.colorTempPhysicalMaxMireds = clamp(kelvinToMireds(ct[0]), 50, 1000);
      }
      const rgb = num(get('color'));
      if (rgb !== undefined && rgb > 0) {
        const hs = rgbToHs(rgb);
        color.currentHue = degreesToHue(hs.h);
        color.currentSaturation = percentToSat(hs.s);
      }
      if (color.colorTemperatureMireds !== undefined || color.currentHue !== undefined) color.colorMode = color.currentHue !== undefined && color.colorTemperatureMireds === undefined ? 'hs' : 'ct';
      if (Object.keys(color).length) out.push({ capability: 'colorControl', attributes: color });
      break;
    }
    case 'switch':
    case 'outlet': {
      if (typeof on === 'boolean') out.push({ capability: 'onOff', attributes: { onOff: on } });
      const w = num(get('power'));
      if (w !== undefined) out.push({ capability: 'electricalPowerMeasurement', attributes: { activePower: w } });
      break;
    }
    case 'cover': {
      const attributes: Record<string, AttributeValue> = {};
      const cur = num(get('current'));
      const target = num(get('target'));
      if (cur !== undefined) attributes.currentPosition = clamp(Math.round(cur), 0, 100);
      else if (target !== undefined) attributes.currentPosition = clamp(Math.round(target), 0, 100);
      if (target !== undefined) attributes.targetPosition = clamp(Math.round(target), 0, 100);
      const motor = num(get('motor'));
      if (motor !== undefined) {
        attributes.operationalStatus = motor === findEnum(f.props.motor, 'open', 'up') ? 'opening' : motor === findEnum(f.props.motor, 'close', 'down') ? 'closing' : 'stopped';
      }
      if (Object.keys(attributes).length) out.push({ capability: 'windowCovering', attributes });
      break;
    }
    case 'fan': {
      if (typeof on === 'boolean') out.push({ capability: 'onOff', attributes: { onOff: on } });
      const fan: Record<string, AttributeValue> = {};
      const lp = f.props.level ?? f.props.speed;
      const level = num(lp ? values.get(`${lp.siid}.${lp.piid}`) : undefined);
      if (lp && level !== undefined) {
        const all = levels(lp);
        const i = all.indexOf(level);
        if (i >= 0 && all.length) fan.percentCurrent = Math.round(((i + 1) / all.length) * 100);
        else if (lp.range) fan.percentCurrent = Math.round(((level - lp.range[0]) / Math.max(1, lp.range[1] - lp.range[0])) * 100);
      }
      const mode = num(get('mode'));
      if (on === false) fan.fanMode = 'off';
      else if (mode !== undefined && mode === findEnum(f.props.mode, 'auto')) fan.fanMode = 'auto';
      else if (fan.percentCurrent !== undefined) fan.fanMode = Number(fan.percentCurrent) <= 34 ? 'low' : Number(fan.percentCurrent) <= 67 ? 'medium' : 'high';
      if (Object.keys(fan).length) out.push({ capability: 'fanControl', attributes: fan });
      break;
    }
    case 'climate': {
      const t: Record<string, AttributeValue> = {};
      const target = num(get('target'));
      if (target !== undefined) t.targetTemperature = target;
      const room = num(get('temperature'));
      if (room !== undefined) t.localTemperature = Math.round(room * 10) / 10;
      if (f.props.target?.range) {
        t.minSetpoint = f.props.target.range[0];
        t.maxSetpoint = f.props.target.range[1];
      }
      const modes = climateModes(f);
      t.supportedModes = ['off', ...modes.map((m) => m.mode)].join(',');
      const mode = num(get('mode'));
      if (on === false) t.systemMode = 'off';
      else if (f.props.heaterOnly && on === true) t.systemMode = 'heat';
      else if (mode !== undefined) {
        const m = modes.find((x) => x.value === mode);
        if (m) t.systemMode = m.mode;
      }
      if (t.systemMode) t.runningState = t.systemMode === 'off' ? 'idle' : t.systemMode === 'heat' ? 'heating' : t.systemMode === 'cool' ? 'cooling' : t.systemMode === 'dry' ? 'drying' : t.systemMode === 'fan_only' ? 'fan' : 'idle';
      out.push({ capability: 'thermostat', attributes: t });
      break;
    }
    case 'temperature': {
      const v = num(get('value'));
      if (v !== undefined) out.push({ capability: 'temperatureMeasurement', attributes: { measuredValue: Math.round(v * 10) / 10 } });
      break;
    }
    case 'humidity': {
      const v = num(get('value'));
      if (v !== undefined) out.push({ capability: 'relativeHumidityMeasurement', attributes: { measuredValue: Math.round(v) } });
      break;
    }
    case 'battery': {
      const v = num(get('level'));
      if (v !== undefined) out.push({ capability: 'powerSource', attributes: { batPercentRemaining: v, batChargeLevelLow: v < 20 } });
      break;
    }
  }
  return out;
}

type SystemMode = 'heat' | 'cool' | 'auto' | 'dry' | 'fan_only';

function climateModes(f: Feature): { mode: SystemMode; value: number }[] {
  if (f.props.heaterOnly) return [{ mode: 'heat', value: -1 }];
  const out: { mode: SystemMode; value: number }[] = [];
  const add = (mode: SystemMode, ...words: string[]) => {
    const v = findEnum(f.props.mode, ...words);
    if (v !== undefined && !out.some((o) => o.value === v)) out.push({ mode, value: v });
  };
  add('cool', 'cool');
  add('heat', 'heat', 'warm');
  add('dry', 'dry', 'dehumid');
  add('fan_only', 'fan', 'wind');
  add('auto', 'auto');
  return out;
}

export function featureCommands(f: Feature): Record<string, string[]> {
  switch (f.kind) {
    case 'light':
      return {
        onOff: ['on', 'off', 'toggle'],
        ...(f.props.brightness ? { levelControl: ['moveToLevel'] } : {}),
        ...(f.props.ct || f.props.color ? { colorControl: [...(f.props.ct ? ['moveToColorTemperature'] : []), ...(f.props.color ? ['moveToHueAndSaturation'] : [])] } : {}),
      };
    case 'switch':
    case 'outlet':
      return { onOff: ['on', 'off', 'toggle'] };
    case 'cover':
      return { windowCovering: ['open', 'close', 'stop', ...(f.props.target?.writable ? ['goToPosition'] : [])] };
    case 'fan':
      return { onOff: ['on', 'off', 'toggle'], fanControl: ['setPercent', 'setMode'] };
    case 'climate':
      return { thermostat: ['setSystemMode', 'setTargetTemperature'] };
  }
  return {};
}

const w = (p: PropRef | undefined, value: unknown): PropWrite[] => (p ? [{ siid: p.siid, piid: p.piid, value }] : []);

/** Livynq command → MIoT property writes. */
export function commandToWrites(f: Feature, capability: string, command: string, params: Record<string, unknown>, state: { on: boolean }): PropWrite[] {
  const P = f.props;
  switch (`${capability}.${command}`) {
    case 'onOff.on':
      return w(P.on, true);
    case 'onOff.off':
      return w(P.on, false);
    case 'onOff.toggle':
      return w(P.on, !state.on);
    case 'levelControl.moveToLevel': {
      const r = P.brightness?.range ?? [1, 100, 1];
      return [...(state.on ? [] : w(P.on, true)), ...w(P.brightness, clamp(Math.max(1, levelToPercent(Number(params.level))), r[0], r[1]))];
    }
    case 'colorControl.moveToColorTemperature': {
      const r = P.ct?.range ?? [2700, 6500, 1];
      return [...(state.on ? [] : w(P.on, true)), ...w(P.ct, clamp(miredsToKelvin(Number(params.colorTemperatureMireds)), r[0], r[1]))];
    }
    case 'colorControl.moveToHueAndSaturation':
      return [...(state.on ? [] : w(P.on, true)), ...w(P.color, hsToRgb(hueToDegrees(Number(params.hue)), satToPercent(Number(params.saturation))))];
    case 'windowCovering.open':
      return P.motor ? w(P.motor, findEnum(P.motor, 'open', 'up') ?? 1) : w(P.target, 100);
    case 'windowCovering.close':
      return P.motor ? w(P.motor, findEnum(P.motor, 'close', 'down') ?? 2) : w(P.target, 0);
    case 'windowCovering.stop':
      return w(P.motor, findEnum(P.motor, 'pause', 'stop') ?? 0);
    case 'windowCovering.goToPosition':
      return w(P.target, clamp(Math.round(Number(params.position)), 0, 100));
    case 'fanControl.setPercent': {
      const pct = clamp(Number(params.percent), 0, 100);
      if (pct === 0) return w(P.on, false);
      const lp = P.level ?? P.speed;
      if (!lp) return w(P.on, true);
      const all = levels(lp);
      const level = all.length ? all[Math.min(all.length - 1, Math.max(0, Math.ceil((pct / 100) * all.length) - 1))] : pct;
      // Leave "auto" when a speed is chosen.
      const manual = findEnum(P.mode, 'favorite', 'manual', 'straight', 'direct');
      return [...(state.on ? [] : w(P.on, true)), ...(manual !== undefined && P.mode?.writable ? w(P.mode, manual) : []), ...w(lp, level)];
    }
    case 'fanControl.setMode': {
      const mode = String(params.mode);
      if (mode === 'off') return w(P.on, false);
      if (mode === 'on') return w(P.on, true);
      if (mode === 'auto') {
        const auto = findEnum(P.mode, 'auto');
        return [...(state.on ? [] : w(P.on, true)), ...(auto !== undefined ? w(P.mode, auto) : [])];
      }
      return commandToWrites(f, 'fanControl', 'setPercent', { percent: mode === 'low' ? 33 : mode === 'medium' ? 66 : 100 }, state);
    }
    case 'thermostat.setSystemMode': {
      const mode = String(params.mode);
      if (mode === 'off') return w(P.on, false);
      if (P.heaterOnly) {
        if (mode !== 'heat') throw new Error('This heater only supports heat / off');
        return w(P.on, true);
      }
      const m = climateModes(f).find((x) => x.mode === mode);
      if (!m) throw new Error(`Mode ${mode} is not supported by this device`);
      return [...(state.on ? [] : w(P.on, true)), ...w(P.mode, m.value)];
    }
    case 'thermostat.setTargetTemperature': {
      const r = P.target?.range ?? [16, 30, 1];
      const step = r[2] || 1;
      return w(P.target, clamp(Math.round(Number(params.temperature) / step) * step, r[0], r[1]));
    }
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}
