import type { AttributeValue, DeviceDTO, EndpointDefinition, Room } from '@livynq/model';
import { hueToDegrees, levelToPercent, miredsToKelvin, satToPercent } from '@livynq/model';
import type { IconName } from '../components/icons.tsx';
import type { MessageKey, Translate } from './i18n.ts';

export type DeviceKind = 'camera' | 'light' | 'plug' | 'switch' | 'fan' | 'cover' | 'garage' | 'climate' | 'lock' | 'button' | 'motion' | 'contact' | 'leak' | 'sensor';

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
  if (types.some((t) => t.startsWith('camera.')) || endpointWith(d, 'camera')) return 'camera';
  if (types.includes('lock.door')) return 'lock';
  if (types.includes('cover.garage') || types.includes('cover.gate')) return 'garage';
  if (types.some((t) => t.startsWith('cover.'))) return 'cover';
  if (types.some((t) => t.startsWith('climate.'))) return 'climate';
  if (types.includes('fan.fan')) return 'fan';
  if (types.some((t) => t.startsWith('light.'))) return 'light';
  if (types.some((t) => t.startsWith('plug.'))) return 'plug';
  if (types.some((t) => t.startsWith('switch.'))) return 'switch';
  if (types.includes('binarySensor.leak')) return 'leak';
  if (types.includes('binarySensor.contact')) return 'contact';
  if (types.includes('binarySensor.occupancy')) return 'motion';
  if (types.includes('event.button')) return 'button';
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
  /** Already shown by a dedicated control (position bar, fan speed, thermostat), so no reading tile. */
  controlled?: boolean;
}

const numericAttrs: { capability: string; attribute: string; label: MessageKey; icon: IconName; fmt: (v: number) => string; controlled?: boolean }[] = [
  { capability: 'temperatureMeasurement', attribute: 'measuredValue', label: 'dev.temperature', icon: 'thermometer', fmt: (v) => `${round1(v)}°C` },
  { capability: 'relativeHumidityMeasurement', attribute: 'measuredValue', label: 'dev.humidity', icon: 'droplet', fmt: (v) => `${Math.round(v)}%` },
  { capability: 'illuminanceMeasurement', attribute: 'measuredValue', label: 'dev.illuminance', icon: 'sun', fmt: (v) => `${Math.round(v)} lx` },
  { capability: 'electricalPowerMeasurement', attribute: 'activePower', label: 'dev.powerUse', icon: 'zap', fmt: (v) => `${round1(v)} W` },
  { capability: 'powerSource', attribute: 'batPercentRemaining', label: 'dev.battery', icon: 'battery', fmt: (v) => `${Math.round(v)}%` },
  { capability: 'thermostat', attribute: 'localTemperature', label: 'dev.roomTemp', icon: 'thermometer', fmt: (v) => `${round1(v)}°C`, controlled: true },
  { capability: 'windowCovering', attribute: 'currentPosition', label: 'dev.position', icon: 'blinds', fmt: (v) => `${Math.round(v)}%`, controlled: true },
  { capability: 'fanControl', attribute: 'percentCurrent', label: 'dev.fanSpeed', icon: 'fan', fmt: (v) => `${Math.round(v)}%`, controlled: true },
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
      out.push({ capability: a.capability, attribute: a.attribute, endpointId: ep.id, label: a.label, icon: a.icon, value, text: a.fmt(value), controlled: a.controlled });
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

// --------------------------------------------------------------------------- covers, climate, fans, locks, buttons

export type CoverMotion = 'stopped' | 'opening' | 'closing';

export interface CoverState {
  endpointId: number;
  /** 0..100, 100 = fully open. */
  position?: number;
  target?: number;
  motion: CoverMotion;
  obstructed: boolean;
}

export function coverState(d: DeviceDTO): CoverState | undefined {
  const ep = endpointWith(d, 'windowCovering');
  if (!ep) return undefined;
  const s = d.state[ep.id]?.windowCovering ?? {};
  const op = s.operationalStatus;
  return {
    endpointId: ep.id,
    position: num(s.currentPosition),
    target: num(s.targetPosition),
    motion: op === 'opening' || op === 'closing' ? op : 'stopped',
    obstructed: s.obstructed === true,
  };
}

export const SYSTEM_MODES = ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'] as const;
export type SystemMode = (typeof SYSTEM_MODES)[number];
export type RunningState = 'idle' | 'heating' | 'cooling' | 'drying' | 'fan';

export interface ClimateState {
  endpointId: number;
  current?: number;
  target?: number;
  mode?: SystemMode;
  modes: SystemMode[];
  running: RunningState;
  min: number;
  max: number;
  /** Endpoint with fanControl on the same device (air conditioners), if any. */
  fan?: FanState;
}

export function climateState(d: DeviceDTO): ClimateState | undefined {
  const ep = endpointWith(d, 'thermostat');
  if (!ep) return undefined;
  const s = d.state[ep.id]?.thermostat ?? {};
  const mode = SYSTEM_MODES.find((m) => m === s.systemMode);
  const listed = typeof s.supportedModes === 'string' ? s.supportedModes.split(',').map((m) => m.trim()) : [];
  const modes = SYSTEM_MODES.filter((m) => listed.includes(m));
  const rs = s.runningState;
  return {
    endpointId: ep.id,
    current: num(s.localTemperature),
    target: num(s.targetTemperature),
    mode,
    // Unknown support: offer the basics rather than nothing.
    modes: modes.length ? modes : ['off', 'heat', 'cool', 'auto'],
    running: rs === 'heating' || rs === 'cooling' || rs === 'drying' || rs === 'fan' ? rs : 'idle',
    min: num(s.minSetpoint) ?? 7,
    max: num(s.maxSetpoint) ?? 30,
    fan: fanState(d),
  };
}

export const FAN_MODES = ['low', 'medium', 'high', 'auto'] as const;

export interface FanState {
  endpointId: number;
  percent?: number;
  mode?: string;
  /** Endpoint carrying onOff for dedicated fans; ACs have none. */
  onOffEndpoint?: number;
  on?: boolean;
}

export function fanState(d: DeviceDTO): FanState | undefined {
  const ep = endpointWith(d, 'fanControl');
  if (!ep) return undefined;
  const s = d.state[ep.id] ?? {};
  const hasOnOff = ep.capabilities.includes('onOff');
  return {
    endpointId: ep.id,
    percent: num(s.fanControl?.percentCurrent),
    mode: typeof s.fanControl?.fanMode === 'string' ? s.fanControl.fanMode : undefined,
    onOffEndpoint: hasOnOff ? ep.id : undefined,
    on: hasOnOff ? s.onOff?.onOff === true : undefined,
  };
}

export type LockStateValue = 'locked' | 'unlocked' | 'jammed' | 'unknown';

export function lockState(d: DeviceDTO): { endpointId: number; state: LockStateValue } | undefined {
  const ep = endpointWith(d, 'doorLock');
  if (!ep) return undefined;
  const v = d.state[ep.id]?.doorLock?.lockState;
  return { endpointId: ep.id, state: v === 'locked' || v === 'unlocked' || v === 'jammed' ? v : 'unknown' };
}

export interface ButtonState {
  event?: 'single' | 'double' | 'long' | 'release';
  at?: number;
  action?: string;
}

export function buttonState(d: DeviceDTO): ButtonState {
  const ep = endpointWith(d, 'genericSwitch');
  const s = ep ? (d.state[ep.id]?.genericSwitch ?? {}) : {};
  const e = s.lastEvent;
  return {
    event: e === 'single' || e === 'double' || e === 'long' || e === 'release' ? e : undefined,
    at: num(s.lastEventAt),
    action: typeof s.lastAction === 'string' && s.lastAction ? s.lastAction : undefined,
  };
}

/** Warm orange while heating, cool blue while cooling; used as card glow and indicator dot. */
export const HEAT_COLOR = 'oklch(0.72 0.16 50)';
export const COOL_COLOR = 'oklch(0.72 0.12 235)';

export function runningColor(r: RunningState): string | undefined {
  return r === 'heating' ? HEAT_COLOR : r === 'cooling' ? COOL_COLOR : undefined;
}

export const formatTemp = (v: number | undefined) => (v === undefined ? '—' : `${round1(v)}°`);

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
  cover?: CoverState;
  climate?: ClimateState;
  fan?: FanState;
  lock?: LockStateValue;
  button?: ButtonState;
  camera?: CameraState;
}

export interface CameraState {
  endpointId: number;
  streaming: boolean;
  codec?: string;
  width?: number;
  height?: number;
  hasAudio: boolean;
  doorbell: boolean;
}

export function cameraState(d: DeviceDTO): CameraState | undefined {
  const ep = endpointWith(d, 'camera');
  if (!ep) return undefined;
  const c = d.state[ep.id]?.camera ?? {};
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  return {
    endpointId: ep.id,
    streaming: c.streaming === true,
    codec: typeof c.codec === 'string' && c.codec !== 'unknown' ? c.codec : undefined,
    width: num(c.width),
    height: num(c.height),
    hasAudio: c.hasAudio === true,
    doorbell: d.endpoints.some((e) => e.deviceType === 'camera.doorbell'),
  };
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
    case 'camera': {
      const c = cameraState(d);
      const occ = attr(d, 'occupancySensing', 'occupied') === true;
      const res = c?.width && c.height ? `${c.height >= 2160 ? '4K' : `${c.height}p`}` : undefined;
      const text = occ ? t('state.detected') : c?.streaming ? t('cam.live') : (res ?? t('cam.camera'));
      return { kind, icon: c?.doorbell ? 'doorbell' : 'camera', tone: occ ? 'active' : 'idle', stateText: text, camera: c };
    }
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
    case 'fan': {
      const f = fanState(d);
      const on = f?.on ?? false;
      const text = on ? (f?.percent !== undefined ? `${f.percent}%` : t('common.on')) : t('common.off');
      return { kind, icon: 'fan', tone: on ? 'active' : 'idle', stateText: text, toggleEndpoint: f?.onOffEndpoint, on, fan: f };
    }
    case 'cover':
    case 'garage': {
      const c = coverState(d);
      const garage = kind === 'garage';
      let text: string;
      if (!c || c.position === undefined) text = '—';
      else if (c.motion !== 'stopped') text = `${t(c.motion === 'opening' ? 'cover.opening' : 'cover.closing')} ${c.position}%`;
      else if (c.position === 0) text = t('state.closed');
      else if (c.position === 100 || garage) text = t('state.open');
      else text = t('cover.openPct', { n: c.position });
      if (c?.obstructed) text = `${text} · ${t('cover.obstructed')}`;
      const open = (c?.position ?? 0) > 0 || (c?.motion ?? 'stopped') !== 'stopped';
      return { kind, icon: garage ? 'garage' : 'blinds', tone: c?.obstructed ? 'alert' : open ? 'active' : 'idle', stateText: text, cover: c };
    }
    case 'climate': {
      const c = climateState(d);
      const off = !c?.mode || c.mode === 'off';
      const glow = c ? runningColor(c.running) : undefined;
      const text = !c ? '—' : off ? `${t('common.off')} · ${formatTemp(c.current)}` : `${t(`climate.mode.${c.mode!}`)} · ${formatTemp(c.target)}`;
      return { kind, icon: 'airVent', tone: off ? 'idle' : 'active', stateText: text, climate: c, glow };
    }
    case 'lock': {
      const l = lockState(d);
      const state = l?.state ?? 'unknown';
      const text = withBattery(t(`lock.${state}`), rs, t);
      return { kind, icon: state === 'unlocked' ? 'lockOpen' : 'lock', tone: state === 'jammed' ? 'alert' : state === 'unlocked' ? 'active' : 'idle', stateText: text, lock: state };
    }
    case 'button': {
      const b = buttonState(d);
      return { kind, icon: 'circleDot', tone: 'idle', stateText: b.event ? t(`button.${b.event}`) : t('button.never'), button: b };
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
