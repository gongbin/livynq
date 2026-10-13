import { DeviceTypes, clamp, hsToXy, hueToDegrees, percentToLevel, levelToPercent, satToPercent, xyToHs, degreesToHue, percentToSat, type AttributeValue, type CapabilityId } from '@livynq/sdk';
import type { HueResource } from './clip.ts';

/** Hue CLIP v2 resources (a device and the services it owns) ⇄ Livynq endpoints. */

export interface ServicePlan {
  /** "light:<rid>", stable; used for endpoint ids */
  key: string;
  rid: string;
  rtype: string;
  deviceType: string;
  capabilities: CapabilityId[];
  name?: string;
}

export interface DevicePlan {
  id: string;
  hueId: string;
  name: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  services: ServicePlan[];
  /** zigbee_connectivity service, for availability */
  connectivity?: string;
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };

const SUPPORTED = new Set(['light', 'motion', 'temperature', 'light_level', 'button', 'contact', 'device_power']);

/** Plans every device except the bridge itself. Devices without supported services are skipped. */
export function planDevices(resources: HueResource[]): DevicePlan[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const out: DevicePlan[] = [];
  for (const d of resources) {
    if (d.type !== 'device') continue;
    const refs = (d.services ?? []) as { rid: string; rtype: string }[];
    if (refs.some((s) => s.rtype === 'bridge')) continue;
    const services: ServicePlan[] = [];
    for (const ref of refs) {
      const r = byId.get(ref.rid);
      if (!r || !SUPPORTED.has(ref.rtype)) continue;
      const p = planService(r);
      if (p) services.push(p);
    }
    if (!services.length) continue;
    const buttons = services.filter((s) => s.rtype === 'button');
    for (const b of buttons) {
      const control = (byId.get(b.rid)?.metadata as { control_id?: number } | undefined)?.control_id;
      if (buttons.length > 1 && control) b.name = `Button ${control}`;
    }
    const meta = d.metadata as { name?: string } | undefined;
    const product = d.product_data as { manufacturer_name?: string; product_name?: string; model_id?: string; software_version?: string } | undefined;
    out.push({
      id: `hue:${d.id}`,
      hueId: d.id,
      name: meta?.name || product?.product_name || 'Hue device',
      manufacturer: product?.manufacturer_name,
      model: product?.product_name ?? product?.model_id,
      firmware: product?.software_version,
      services: services.sort((a, b) => order(a.rtype) - order(b.rtype) || a.key.localeCompare(b.key)),
      connectivity: refs.find((s) => s.rtype === 'zigbee_connectivity')?.rid,
    });
  }
  return out;
}

const order = (rtype: string) => ['light', 'button', 'motion', 'contact', 'temperature', 'light_level', 'device_power'].indexOf(rtype);

export function planService(r: HueResource): ServicePlan | undefined {
  const base = { key: `${r.type}:${r.id}`, rid: r.id, rtype: r.type };
  switch (r.type) {
    case 'light': {
      const color = r.color !== undefined;
      const ct = r.color_temperature !== undefined;
      const dim = r.dimming !== undefined;
      const capabilities: CapabilityId[] = ['onOff'];
      if (dim || ct) capabilities.push('levelControl');
      if (color || ct) capabilities.push('colorControl');
      const deviceType = color ? DeviceTypes.ExtendedColorLight.id : ct ? DeviceTypes.ColorTemperatureLight.id : dim ? DeviceTypes.DimmableLight.id : DeviceTypes.OnOffLight.id;
      return { ...base, deviceType, capabilities };
    }
    case 'motion':
      return { ...base, deviceType: DeviceTypes.OccupancySensor.id, capabilities: ['occupancySensing'] };
    case 'temperature':
      return { ...base, deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] };
    case 'light_level':
      return { ...base, deviceType: DeviceTypes.LightSensor.id, capabilities: ['illuminanceMeasurement'] };
    case 'button':
      return { ...base, deviceType: DeviceTypes.GenericSwitch.id, capabilities: ['genericSwitch'] };
    case 'contact':
      return { ...base, deviceType: DeviceTypes.ContactSensor.id, capabilities: ['booleanState'] };
    case 'device_power':
      return (r.power_state as { battery_level?: number } | undefined)?.battery_level !== undefined ? { ...base, deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'] } : undefined;
  }
  return undefined;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A full or partial (event) resource → updates. `full` is the cached resource after merging. */
export function resourceToUpdates(plan: ServicePlan, r: Record<string, unknown>, full: Record<string, unknown> = r): Update[] {
  const out: Update[] = [];
  switch (plan.rtype) {
    case 'light': {
      const on = (r.on as { on?: boolean } | undefined)?.on;
      if (typeof on === 'boolean') out.push({ capability: 'onOff', attributes: { onOff: on } });
      const bri = num((r.dimming as { brightness?: number } | undefined)?.brightness);
      if (bri !== undefined && plan.capabilities.includes('levelControl')) out.push({ capability: 'levelControl', attributes: { currentLevel: percentToLevel(bri) } });
      if (!plan.capabilities.includes('colorControl')) break;
      const color: Record<string, AttributeValue> = {};
      const ct = r.color_temperature as { mirek?: number | null; mirek_valid?: boolean; mirek_schema?: { mirek_minimum: number; mirek_maximum: number } } | undefined;
      if (ct?.mirek_schema) {
        color.colorTempPhysicalMinMireds = ct.mirek_schema.mirek_minimum;
        color.colorTempPhysicalMaxMireds = ct.mirek_schema.mirek_maximum;
      }
      const mirek = num(ct?.mirek);
      if (mirek !== undefined && ct?.mirek_valid !== false) {
        color.colorTemperatureMireds = clamp(mirek, 50, 1000);
        color.colorMode = 'ct';
      }
      const xy = (r.color as { xy?: { x: number; y: number } } | undefined)?.xy;
      if (xy) {
        const hs = xyToHs(xy.x, xy.y);
        color.currentHue = degreesToHue(hs.h);
        color.currentSaturation = percentToSat(hs.s);
        // An xy event while the cached mirek is invalid means the light is in color mode.
        const fullCt = full.color_temperature as { mirek_valid?: boolean; mirek?: number | null } | undefined;
        if (mirek === undefined && (fullCt?.mirek_valid === false || fullCt?.mirek == null)) color.colorMode = 'hs';
      }
      if (Object.keys(color).length) out.push({ capability: 'colorControl', attributes: color });
      break;
    }
    case 'motion': {
      const m = r.motion as { motion?: boolean; motion_report?: { motion: boolean } } | undefined;
      const v = m?.motion_report?.motion ?? m?.motion;
      if (typeof v === 'boolean') out.push({ capability: 'occupancySensing', attributes: { occupied: v } });
      break;
    }
    case 'temperature': {
      const t = r.temperature as { temperature?: number; temperature_report?: { temperature: number } } | undefined;
      const v = num(t?.temperature_report?.temperature ?? t?.temperature);
      if (v !== undefined) out.push({ capability: 'temperatureMeasurement', attributes: { measuredValue: Math.round(v * 10) / 10 } });
      break;
    }
    case 'light_level': {
      const l = r.light as { light_level?: number; light_level_report?: { light_level: number } } | undefined;
      const v = num(l?.light_level_report?.light_level ?? l?.light_level);
      // Hue reports 10000·log10(lux) + 1
      if (v !== undefined) out.push({ capability: 'illuminanceMeasurement', attributes: { measuredValue: Math.round(Math.pow(10, (v - 1) / 10000)) } });
      break;
    }
    case 'contact': {
      const state = (r.contact_report as { state?: string } | undefined)?.state;
      if (state) out.push({ capability: 'booleanState', attributes: { stateValue: state === 'contact' } });
      break;
    }
    case 'device_power': {
      const pct = num((r.power_state as { battery_level?: number } | undefined)?.battery_level);
      if (pct !== undefined) out.push({ capability: 'powerSource', attributes: { batPercentRemaining: pct, batChargeLevelLow: pct < 20 } });
      break;
    }
  }
  return out;
}

/** Button presses only come as events (the cached last_event would replay old presses). */
export function buttonEventToUpdate(r: Record<string, unknown>): Update | undefined {
  const b = r.button as { last_event?: string; button_report?: { event: string } } | undefined;
  const raw = b?.button_report?.event ?? b?.last_event;
  const lastEvent = ({ short_release: 'single', long_press: 'long', long_release: 'release' } as Record<string, string>)[raw ?? ''];
  if (!raw || !lastEvent) return undefined;
  return { capability: 'genericSwitch', attributes: { lastEvent, lastEventAt: Date.now(), lastAction: raw } };
}

export function serviceCommands(plan: ServicePlan): Record<string, string[]> {
  if (plan.rtype !== 'light') return {};
  const out: Record<string, string[]> = { onOff: ['on', 'off', 'toggle'] };
  if (plan.capabilities.includes('levelControl')) out.levelControl = ['moveToLevel'];
  if (plan.capabilities.includes('colorControl')) out.colorControl = plan.deviceType === DeviceTypes.ExtendedColorLight.id ? ['moveToColorTemperature', 'moveToHueAndSaturation'] : ['moveToColorTemperature'];
  return out;
}

/** Livynq command → PUT body for /clip/v2/resource/light/<rid>. */
export function commandToBody(capability: string, command: string, params: Record<string, unknown>, state: { on: boolean; mirek?: { min: number; max: number } }): Record<string, unknown> {
  const dynamics = params.transitionTime !== undefined ? { dynamics: { duration: Math.round(Number(params.transitionTime) * 100) } } : {};
  switch (`${capability}.${command}`) {
    case 'onOff.on':
      return { on: { on: true } };
    case 'onOff.off':
      return { on: { on: false } };
    case 'onOff.toggle':
      return { on: { on: !state.on } };
    case 'levelControl.moveToLevel':
      return { on: { on: true }, dimming: { brightness: Math.max(1, levelToPercent(Number(params.level))) }, ...dynamics };
    case 'colorControl.moveToColorTemperature': {
      const m = Math.round(Number(params.colorTemperatureMireds));
      return { on: { on: true }, color_temperature: { mirek: state.mirek ? clamp(m, state.mirek.min, state.mirek.max) : clamp(m, 153, 500) }, ...dynamics };
    }
    case 'colorControl.moveToHueAndSaturation':
      return { on: { on: true }, color: { xy: hsToXy(hueToDegrees(Number(params.hue)), satToPercent(Number(params.saturation))) }, ...dynamics };
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}

/** Deep-merges a partial event resource into the cached one. */
export function mergeResource(into: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    const cur = into[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) mergeResource(cur as Record<string, unknown>, v as Record<string, unknown>);
    else into[k] = v;
  }
}
