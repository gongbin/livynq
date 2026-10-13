import { kelvinToMireds, percentToLevel, degreesToHue, percentToSat, getDeviceType } from '@livynq/model';
import { LivynqError } from './errors.ts';
import type { CommandRequest, Home } from './home.ts';
import type { Entity } from './registry.ts';

/** Home Assistant style service target. ids may be single strings or lists, as in HA YAML. */
export interface ServiceTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
}

export interface ServiceCall {
  /** "light.turn_on", "switch.toggle", "homeassistant.turn_off", ... */
  action: string;
  target?: ServiceTarget;
  data?: Record<string, unknown>;
}

export interface ServiceResult {
  entities: string[];
  commands: number;
}

const SUPPORTED: Record<string, string[]> = {
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  homeassistant: ['turn_on', 'turn_off', 'toggle'],
};

export function listServices(): Record<string, string[]> {
  return SUPPORTED;
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Resolves a target to entities. Area ids accept room ids, names or aliases. */
export function resolveTarget(home: Home, target: ServiceTarget = {}): Entity[] {
  const out = new Map<string, Entity>();
  for (const id of list(target.entity_id)) {
    const entity = home.registry.getEntity(id);
    if (!entity) throw new LivynqError('NOT_FOUND', `Entity not found: ${id}`);
    out.set(entity.entityId, entity);
  }
  const deviceIds = new Set(list(target.device_id).map((id) => home.resolveTarget(id).device.id));
  for (const area of list(target.area_id)) {
    const room = home.registry.findRoom(area);
    if (!room) throw new LivynqError('NOT_FOUND', `Area not found: ${area}`);
    for (const d of home.registry.listDevices()) if (d.roomId === room.id) deviceIds.add(d.id);
  }
  if (deviceIds.size) {
    for (const entity of home.registry.listEntities()) if (deviceIds.has(entity.deviceId)) out.set(entity.entityId, entity);
  }
  return [...out.values()];
}

/** Translates an HA service call into capability commands and runs them. */
export async function callService(home: Home, call: ServiceCall, source: string): Promise<ServiceResult> {
  const [domain, service] = call.action.split('.');
  if (!domain || !service || !SUPPORTED[domain]?.includes(service)) {
    throw new LivynqError('NOT_SUPPORTED', `Unsupported action ${call.action}`, `Supported: ${Object.entries(SUPPORTED).flatMap(([d, s]) => s.map((x) => `${d}.${x}`)).join(', ')}`);
  }
  // HA also accepts entity_id inside data.
  const target: ServiceTarget = { ...call.target };
  if (call.data?.entity_id && !target.entity_id) target.entity_id = call.data.entity_id as string | string[];
  const entities = resolveTarget(home, target).filter((e) => (domain === 'homeassistant' ? e.domain === 'light' || e.domain === 'switch' : e.domain === domain));
  if (!entities.length) throw new LivynqError('NOT_FOUND', `No ${domain === 'homeassistant' ? 'light/switch' : domain} entities in target`);

  const data = call.data ?? {};
  let commands = 0;
  const errors: string[] = [];
  await Promise.all(
    entities.map(async (entity) => {
      try {
        for (const request of commandsFor(home, entity, service, data)) {
          await home.command(request, source);
          commands++;
        }
      } catch (err) {
        errors.push(`${entity.entityId}: ${(err as Error).message}`);
      }
    }),
  );
  if (errors.length) throw new LivynqError('INTERNAL', `${errors.length}/${entities.length} entities failed: ${errors.join('; ')}`);
  return { entities: entities.map((e) => e.entityId), commands };
}

function commandsFor(home: Home, entity: Entity, service: string, data: Record<string, unknown>): CommandRequest[] {
  const base = { deviceId: entity.deviceId, endpointId: entity.endpointId };
  const device = home.registry.requireDevice(entity.deviceId);
  const endpoint = device.endpoints.find((e) => e.id === entity.endpointId)!;
  const has = (cap: string) => endpoint.capabilities.includes(cap as never);
  const isOn = home.registry.getAttribute(entity.deviceId, entity.endpointId, 'onOff', 'onOff') === true;
  const transitionTime = typeof data.transition === 'number' ? Math.round(data.transition * 10) : undefined;
  const withTransition = (params: Record<string, unknown>) => (transitionTime === undefined ? params : { ...params, transitionTime });

  if (service === 'turn_off') return [{ ...base, capability: 'onOff', command: 'off' }];
  if (service === 'toggle') return [{ ...base, capability: 'onOff', command: 'toggle' }];

  const out: CommandRequest[] = [];
  const level =
    typeof data.brightness_pct === 'number' ? percentToLevel(data.brightness_pct)
    : typeof data.brightness === 'number' ? percentToLevel((data.brightness / 255) * 100)
    : undefined;
  if (level !== undefined && Number(data.brightness_pct ?? data.brightness) <= 0) return [{ ...base, capability: 'onOff', command: 'off' }];
  if (!isOn || !has('levelControl') || level === undefined) out.push({ ...base, capability: 'onOff', command: 'on' });
  if (level !== undefined) {
    if (!has('levelControl')) throw new LivynqError('NOT_SUPPORTED', `${entity.entityId} is not dimmable`);
    out.push({ ...base, capability: 'levelControl', command: 'moveToLevel', params: withTransition({ level }) });
  }
  const mireds =
    typeof data.color_temp_kelvin === 'number' ? kelvinToMireds(data.color_temp_kelvin)
    : typeof data.kelvin === 'number' ? kelvinToMireds(data.kelvin)
    : typeof data.color_temp === 'number' ? data.color_temp
    : undefined;
  if (mireds !== undefined) {
    if (!has('colorControl')) throw new LivynqError('NOT_SUPPORTED', `${entity.entityId} has no color temperature`);
    out.push({ ...base, capability: 'colorControl', command: 'moveToColorTemperature', params: withTransition({ colorTemperatureMireds: Math.round(mireds) }) });
  }
  if (Array.isArray(data.hs_color)) {
    if (!has('colorControl') || getDeviceType(endpoint.deviceType)?.id !== 'light.extendedColor') {
      throw new LivynqError('NOT_SUPPORTED', `${entity.entityId} has no color`);
    }
    const [h, s] = data.hs_color as number[];
    out.push({ ...base, capability: 'colorControl', command: 'moveToHueAndSaturation', params: withTransition({ hue: degreesToHue(Number(h)), saturation: percentToSat(Number(s)) }) });
  }
  return out;
}
