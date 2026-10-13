import type { AttributeValue, DeviceDTO, EndpointDefinition, Room } from '@livynq/model';
import { hueToDegrees, levelToPercent, miredsToKelvin, satToPercent } from '@livynq/model';
import type { IconName } from '../components/icons.tsx';
import type { MessageKey, Translate } from './i18n.ts';

export type DeviceKind = 'light' | 'plug' | 'switch' | 'motion' | 'contact' | 'leak' | 'sensor';

/** Tone drives card coloring: amber when "on/active", alert when something needs attention. */
export type Tone = 'idle' | 'active' | 'alert' | 'offline';

export function endpointWith(d: DeviceDTO, capability: string): EndpointDefinition | undefined {
  return d.endpoints.find((e) => e.capabilities.includes(capability as never));
}

export function attr(d: DeviceDTO, capability: string, attribute: string): AttributeValue | undefined {
  const ep = endpointWith(d, capability);
  return ep ? d.state[ep.id]?.[capability]?.[attribute] : undefined;
}

const num = (v: AttributeValue | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function deviceKind(d: DeviceDTO): DeviceKind {
  const types = d.endpoints.map((e) => e.deviceType);
  if (types.some((t) => t.startsWith('light.'))) return 'light';
  if (types.some((t) => t.startsWith('plug.'))) return 'plug';
  if (types.some((t) => t.startsWith('switch.'))) return 'switch';
  if (types.includes('binarySensor.leak')) return 'leak';
  if (types.includes('binarySensor.contact')) return 'contact';
  if (types.includes('binarySensor.occupancy')) return 'motion';
  if (endpointWith(d, 'onOff')) return 'switch';
  return 'sensor';
}

export interface Reading {
  capability: string;
  attribute: string;
  endpointId: number;
  label: MessageKey;
  icon: IconName;
  value: number;
  text: string;
}

const numericAttrs: { capability: string; attribute: string; label: MessageKey; icon: IconName; fmt: (v: number) => string }[] = [
  { capability: 'temperatureMeasurement', attribute: 'measuredValue', label: 'dev.temperature', icon: 'thermometer', fmt: (v) => `${round1(v)}°C` },
  { capability: 'relativeHumidityMeasurement', attribute: 'measuredValue', label: 'dev.humidity', icon: 'droplet', fmt: (v) => `${Math.round(v)}%` },
  { capability: 'illuminanceMeasurement', attribute: 'measuredValue', label: 'dev.illuminance', icon: 'sun', fmt: (v) => `${Math.round(v)} lx` },
  { capability: 'electricalPowerMeasurement', attribute: 'activePower', label: 'dev.powerUse', icon: 'zap', fmt: (v) => `${round1(v)} W` },
  { capability: 'powerSource', attribute: 'batPercentRemaining', label: 'dev.battery', icon: 'battery', fmt: (v) => `${Math.round(v)}%` },
];

export const round1 = (v: number) => Math.round(v * 10) / 10;

/** Numeric sensor readings, in display order. Used for card text, sheet tiles and sparklines. */
export function readings(d: DeviceDTO): Reading[] {
  const out: Reading[] = [];
  for (const a of numericAttrs) {
    for (const ep of d.endpoints) {
      if (!ep.capabilities.includes(a.capability as never)) continue;
      const value = num(d.state[ep.id]?.[a.capability]?.[a.attribute]);
      if (value === undefined) continue;
      out.push({ capability: a.capability, attribute: a.attribute, endpointId: ep.id, label: a.label, icon: a.icon, value, text: a.fmt(value) });
    }
  }
  return out;
}

export interface LightState {
  endpointId: number;
  on: boolean;
  /** 0..100, undefined when not dimmable. */
  percent?: number;
  hasColorTemp: boolean;
  hasHue: boolean;
  kelvin?: number;
  kelvinRange: [number, number];
  hueDeg?: number;
  satPct?: number;
  colorMode?: string;
}

export function lightState(d: DeviceDTO): LightState | undefined {
  const ep = endpointWith(d, 'onOff');
  if (!ep) return undefined;
  const s = d.state[ep.id] ?? {};
  const level = num(s.levelControl?.currentLevel);
  const cc = s.colorControl ?? {};
  const mireds = num(cc.colorTemperatureMireds);
  const minM = num(cc.colorTempPhysicalMinMireds) ?? 153;
  const maxM = num(cc.colorTempPhysicalMaxMireds) ?? 500;
  const hasColor = ep.capabilities.includes('colorControl');
  const hue = num(cc.currentHue);
  const sat = num(cc.currentSaturation);
  return {
    endpointId: ep.id,
    on: s.onOff?.onOff === true,
    percent: ep.capabilities.includes('levelControl') ? (level === undefined ? undefined : levelToPercent(level)) : undefined,
    hasColorTemp: hasColor,
    hasHue: hasColor && ep.deviceType === 'light.extendedColor',
    kelvin: mireds ? miredsToKelvin(mireds) : undefined,
    kelvinRange: [miredsToKelvin(maxM), miredsToKelvin(minM)],
    hueDeg: hue === undefined ? undefined : hueToDegrees(hue),
    satPct: sat === undefined ? undefined : satToPercent(sat),
    colorMode: typeof cc.colorMode === 'string' ? cc.colorMode : undefined,
  };
}

/** Approximate CSS color for a color temperature, warm amber → neutral → cool blue. */
export function kelvinColor(k: number): string {
  const t = Math.min(1, Math.max(0, (k - 2000) / 4500));
  const warm = 'oklch(0.84 0.13 70)';
  const cool = 'oklch(0.9 0.05 240)';
  return `color-mix(in oklab, ${cool} ${Math.round(t * 100)}%, ${warm})`;
}

/** The color a lit light "glows" with, or undefined when off. */
export function glowColor(l: LightState | undefined): string | undefined {
  if (!l?.on) return undefined;
  if (l.hasHue && (l.colorMode === 'hs' || l.colorMode === 'xy') && l.hueDeg !== undefined) {
    // Matter hue is an HSV hue, which maps onto CSS hsl() hue directly.
    const sat = Math.round(30 + ((l.satPct ?? 100) / 100) * 55);
    return `hsl(${l.hueDeg} ${sat}% 64%)`;
  }
  if (l.kelvin !== undefined) return kelvinColor(l.kelvin);
  return 'var(--amber)';
}

export interface DeviceView {
  kind: DeviceKind;
  icon: IconName;
  tone: Tone;
  stateText: string;
  /** Endpoint carrying onOff, when the main card toggle applies. */
  toggleEndpoint?: number;
  on?: boolean;
  light?: LightState;
  glow?: string;
}

export function describe(d: DeviceDTO, t: Translate): DeviceView {
  const kind = deviceKind(d);
  const view = describeOnline(d, kind, t);
  if (d.availability === 'offline') return { ...view, tone: 'offline', stateText: t('common.offline'), glow: undefined };
  if (d.availability === 'unknown' && !Object.keys(d.state).length) return { ...view, tone: 'offline', stateText: t('common.unknown'), glow: undefined };
  return view;
}

function describeOnline(d: DeviceDTO, kind: DeviceKind, t: Translate): DeviceView {
  const rs = readings(d);
  switch (kind) {
    case 'light': {
      const l = lightState(d);
      const on = l?.on ?? false;
      const text = on ? (l?.percent !== undefined ? `${l.percent}%` : t('common.on')) : t('common.off');
      const ceiling = /ceiling|吸顶|主灯/i.test(d.name);
      return { kind, icon: ceiling ? 'lampCeiling' : 'bulb', tone: on ? 'active' : 'idle', stateText: text, toggleEndpoint: l?.endpointId, on, light: l, glow: glowColor(l) };
    }
    case 'plug':
    case 'switch': {
      const ep = endpointWith(d, 'onOff');
      const on = ep ? d.state[ep.id]?.onOff?.onOff === true : false;
      const power = rs.find((r) => r.capability === 'electricalPowerMeasurement');
      const text = on ? (power ? power.text : t('common.on')) : t('common.off');
      return { kind, icon: kind === 'plug' ? 'plug' : 'toggle', tone: on ? 'active' : 'idle', stateText: text, toggleEndpoint: ep?.id, on };
    }
    case 'motion': {
      const occ = attr(d, 'occupancySensing', 'occupied') === true;
      return { kind, icon: 'motion', tone: occ ? 'active' : 'idle', stateText: occ ? t('state.detected') : t('state.clear') };
    }
    case 'contact': {
      const v = attr(d, 'booleanState', 'stateValue');
      // booleanState.stateValue = true means the contact is closed.
      const open = v === false;
      const text = v === undefined || v === null ? '—' : open ? t('state.open') : t('state.closed');
      return { kind, icon: open ? 'doorOpen' : 'door', tone: open ? 'active' : 'idle', stateText: withBattery(text, rs, t) };
    }
    case 'leak': {
      const wet = attr(d, 'booleanState', 'stateValue') === true;
      return { kind, icon: 'droplet', tone: wet ? 'alert' : 'idle', stateText: withBattery(wet ? t('state.leak') : t('state.dry'), rs, t) };
    }
    case 'sensor': {
      const main = rs.filter((r) => r.capability !== 'powerSource');
      const parts = (main.length ? main : rs).slice(0, 2).map((r) => (r.capability === 'temperatureMeasurement' ? `${round1(r.value)}°` : r.text));
      const icon: IconName = main[0]?.icon ?? (rs.length ? 'battery' : 'gauge');
      const low = attr(d, 'powerSource', 'batChargeLevelLow') === true;
      return { kind, icon, tone: low ? 'alert' : 'idle', stateText: low ? `${parts.join(' · ')} · ${t('state.lowBattery')}` : parts.join(' · ') || '—' };
    }
  }
}

function withBattery(text: string, rs: Reading[], t: Translate): string {
  const bat = rs.find((r) => r.capability === 'powerSource');
  return bat && bat.value <= 20 ? `${text} · ${t('state.lowBattery')}` : text;
}

export function roomName(d: DeviceDTO, rooms: Room[]): string | undefined {
  return d.roomId ? (rooms.find((r) => r.id === d.roomId)?.name ?? d.roomName ?? undefined) : undefined;
}

export function primaryEntity(d: DeviceDTO): string {
  const first = d.endpoints[0];
  return (first && d.entities[first.id]) ?? Object.values(d.entities)[0] ?? d.id;
}

export function sortDevices(devices: DeviceDTO[]): DeviceDTO[] {
  return [...devices].sort((a, b) => a.name.localeCompare(b.name));
}
