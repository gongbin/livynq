import {
  hueToDegrees,
  levelToPercent,
  miredsToKelvin,
  satToPercent,
  type AttributeValue,
  type Device,
} from '@livynq/model';
import type { Home } from './home.ts';
import type { Entity } from './registry.ts';

/** Home Assistant shaped entity state: the lingua franca for automations, HA import and the HA API layer. */
export interface EntityState {
  entity_id: string;
  /** "on" / "off" / a number as string / "unavailable" / "unknown" */
  state: string;
  attributes: Record<string, unknown>;
}

type EndpointState = Record<string, Record<string, AttributeValue>>;

const SENSOR_META: Record<string, { attr: string; deviceClass: string; unit: string }> = {
  temperatureMeasurement: { attr: 'measuredValue', deviceClass: 'temperature', unit: '°C' },
  relativeHumidityMeasurement: { attr: 'measuredValue', deviceClass: 'humidity', unit: '%' },
  illuminanceMeasurement: { attr: 'measuredValue', deviceClass: 'illuminance', unit: 'lx' },
  powerSource: { attr: 'batPercentRemaining', deviceClass: 'battery', unit: '%' },
  electricalPowerMeasurement: { attr: 'activePower', deviceClass: 'power', unit: 'W' },
};

export function entityState(home: Home, entityId: string): EntityState | undefined {
  const entity = home.registry.getEntity(entityId);
  if (!entity) return undefined;
  const device = home.registry.getDevice(entity.deviceId);
  if (!device) return undefined;
  const roomName = device.roomId ? home.registry.getRoom(device.roomId)?.name : undefined;
  return computeEntityState(entity, device, home.registry.getState(device.id)[entity.endpointId] ?? {}, roomName);
}

export function allEntityStates(home: Home): EntityState[] {
  return home.registry
    .listEntities()
    .map((e) => entityState(home, e.entityId))
    .filter((s): s is EntityState => Boolean(s));
}

export function computeEntityState(entity: Entity, device: Device, s: EndpointState, roomName?: string): EntityState {
  const endpoint = device.endpoints.find((e) => e.id === entity.endpointId);
  const attributes: Record<string, unknown> = {
    friendly_name: device.endpoints.length > 1 && endpoint?.name ? `${device.name} ${endpoint.name}` : device.name,
    ...(roomName ? { area: roomName } : {}),
  };
  const result = (state: string): EntityState => ({
    entity_id: entity.entityId,
    state: device.availability === 'offline' ? 'unavailable' : state,
    attributes,
  });
  if (!endpoint) return result('unknown');

  switch (entity.domain) {
    case 'light': {
      const on = s.onOff?.onOff;
      if (on) {
        if (s.levelControl?.currentLevel !== undefined) {
          attributes.brightness = Math.round((levelToPercent(Number(s.levelControl.currentLevel)) / 100) * 255);
        }
        const c = s.colorControl;
        if (c) {
          attributes.color_mode = c.colorMode === 'ct' ? 'color_temp' : c.colorMode === 'hs' ? 'hs' : undefined;
          if (c.colorTemperatureMireds !== undefined) {
            attributes.color_temp = c.colorTemperatureMireds;
            attributes.color_temp_kelvin = miredsToKelvin(Number(c.colorTemperatureMireds));
          }
          if (c.currentHue !== undefined && c.currentSaturation !== undefined) {
            attributes.hs_color = [hueToDegrees(Number(c.currentHue)), satToPercent(Number(c.currentSaturation))];
          }
        }
      }
      return result(on === undefined ? 'unknown' : on ? 'on' : 'off');
    }
    case 'switch': {
      const on = s.onOff?.onOff;
      if (s.electricalPowerMeasurement?.activePower !== undefined) attributes.current_power_w = s.electricalPowerMeasurement.activePower;
      return result(on === undefined ? 'unknown' : on ? 'on' : 'off');
    }
    case 'binary_sensor': {
      if (endpoint.capabilities.includes('occupancySensing')) {
        attributes.device_class = 'motion';
        const v = s.occupancySensing?.occupied;
        return result(v === undefined ? 'unknown' : v ? 'on' : 'off');
      }
      const v = s.booleanState?.stateValue;
      if (endpoint.deviceType === 'binarySensor.leak') {
        attributes.device_class = 'moisture';
        return result(v === undefined ? 'unknown' : v ? 'on' : 'off');
      }
      // HA: door "on" = open; Matter BooleanState true = contact closed.
      attributes.device_class = 'door';
      return result(v === undefined ? 'unknown' : v ? 'off' : 'on');
    }
    case 'cover': {
      const c = s.windowCovering ?? {};
      if (c.currentPosition !== undefined) attributes.current_position = c.currentPosition;
      if (c.currentTilt !== undefined) attributes.current_tilt_position = c.currentTilt;
      attributes.device_class = endpoint.deviceType === 'cover.garage' ? 'garage' : endpoint.deviceType === 'cover.gate' ? 'gate' : 'curtain';
      if (c.operationalStatus === 'opening') return result('opening');
      if (c.operationalStatus === 'closing') return result('closing');
      if (c.currentPosition === undefined) return result('unknown');
      return result(Number(c.currentPosition) > 0 ? 'open' : 'closed');
    }
    case 'climate': {
      const t = s.thermostat ?? {};
      if (t.localTemperature !== undefined) attributes.current_temperature = t.localTemperature;
      if (t.targetTemperature !== undefined) attributes.temperature = t.targetTemperature;
      if (t.targetTemperatureLow !== undefined) attributes.target_temp_low = t.targetTemperatureLow;
      if (t.targetTemperatureHigh !== undefined) attributes.target_temp_high = t.targetTemperatureHigh;
      if (t.minSetpoint !== undefined) attributes.min_temp = t.minSetpoint;
      if (t.maxSetpoint !== undefined) attributes.max_temp = t.maxSetpoint;
      if (typeof t.supportedModes === 'string') attributes.hvac_modes = t.supportedModes.split(',').filter(Boolean);
      if (t.runningState !== undefined) attributes.hvac_action = t.runningState === 'heating' ? 'heating' : t.runningState === 'cooling' ? 'cooling' : t.runningState === 'drying' ? 'drying' : t.runningState === 'fan' ? 'fan' : 'idle';
      if (s.fanControl?.fanMode !== undefined) attributes.fan_mode = s.fanControl.fanMode;
      return result(typeof t.systemMode === 'string' ? t.systemMode : 'unknown');
    }
    case 'fan': {
      const on = s.onOff?.onOff;
      if (s.fanControl?.percentCurrent !== undefined) attributes.percentage = s.fanControl.percentCurrent;
      if (s.fanControl?.fanMode !== undefined) attributes.preset_mode = s.fanControl.fanMode;
      return result(on === undefined ? 'unknown' : on ? 'on' : 'off');
    }
    case 'lock': {
      const l = s.doorLock?.lockState;
      return result(l === 'locked' || l === 'unlocked' || l === 'jammed' ? l : 'unknown');
    }
    case 'event': {
      const g = s.genericSwitch ?? {};
      attributes.event_types = ['single', 'double', 'long', 'release'];
      if (g.lastEvent !== undefined) attributes.event_type = g.lastEvent;
      if (g.lastAction !== undefined) attributes.action = g.lastAction;
      return result(typeof g.lastEventAt === 'number' ? new Date(g.lastEventAt).toISOString() : 'unknown');
    }
    case 'sensor': {
      for (const cap of endpoint.capabilities) {
        const meta = SENSOR_META[cap];
        if (!meta) continue;
        attributes.device_class = meta.deviceClass;
        attributes.unit_of_measurement = meta.unit;
        attributes.state_class = 'measurement';
        const v = s[cap]?.[meta.attr];
        return result(v === undefined || v === null ? 'unknown' : String(v));
      }
      return result('unknown');
    }
    default:
      return result('unknown');
  }
}

export interface EntityChange {
  entityId: string;
  oldState: EntityState | undefined;
  newState: EntityState | undefined;
  ts: number;
}

/**
 * Turns low-level attribute events into HA-style entity state changes, remembering
 * when each entity's state last changed (for `for:` durations in automations).
 */
export class EntityStateTracker {
  readonly #home: Home;
  readonly #states = new Map<string, EntityState>();
  readonly #lastChanged = new Map<string, number>();
  readonly #listeners = new Set<(change: EntityChange) => void>();
  #offs: (() => void)[] = [];

  constructor(home: Home) {
    this.#home = home;
  }

  start(): void {
    const now = Date.now();
    for (const state of allEntityStates(this.#home)) {
      this.#states.set(state.entity_id, state);
      this.#lastChanged.set(state.entity_id, now);
    }
    const refreshDevice = (deviceId: string) => {
      for (const entity of this.#home.registry.listEntities()) if (entity.deviceId === deviceId) this.#refresh(entity.entityId);
    };
    this.#offs = [
      this.#home.bus.on('state', (c) => {
        const entityId = this.#home.registry.entityIdFor(c.deviceId, c.endpointId);
        if (entityId) this.#refresh(entityId);
      }),
      this.#home.bus.on('availability', ({ deviceId }) => refreshDevice(deviceId)),
      this.#home.bus.on('device.added', (d) => refreshDevice(d.id)),
      this.#home.bus.on('device.updated', (d) => refreshDevice(d.id)),
      this.#home.bus.on('device.removed', () => {
        for (const [entityId] of this.#states) {
          if (!this.#home.registry.getEntity(entityId)) this.#emit(entityId, undefined);
        }
      }),
    ];
  }

  stop(): void {
    this.#offs.forEach((off) => off());
    this.#offs = [];
  }

  get(entityId: string): EntityState | undefined {
    return this.#states.get(entityId);
  }

  lastChanged(entityId: string): number | undefined {
    return this.#lastChanged.get(entityId);
  }

  onChange(listener: (change: EntityChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #refresh(entityId: string): void {
    this.#emit(entityId, entityState(this.#home, entityId));
  }

  #emit(entityId: string, newState: EntityState | undefined): void {
    const oldState = this.#states.get(entityId);
    if (JSON.stringify(oldState) === JSON.stringify(newState)) return;
    const ts = Date.now();
    if (newState) this.#states.set(entityId, newState);
    else this.#states.delete(entityId);
    if (oldState?.state !== newState?.state) this.#lastChanged.set(entityId, ts);
    for (const listener of this.#listeners) {
      try {
        listener({ entityId, oldState, newState, ts });
      } catch (err) {
        this.#home.log.error({ err, entityId }, 'entity listener failed');
      }
    }
  }
}
