import { randomUUID } from 'node:crypto';
import {
  defaultExposure,
  domainForDeviceType,
  getCapability,
  getDeviceType,
  suggestEntityId,
  type AttributeValue,
  type Availability,
  type Device,
  type DeviceDefinition,
  type DeviceId,
  type DeviceState,
  type ExposurePolicy,
  type Room,
  type StateChange,
} from '@livynq/model';
import type { EventBus } from './event-bus.ts';
import type { Storage } from './storage.ts';
import { LivynqError } from './errors.ts';

export interface Entity {
  entityId: string;
  deviceId: DeviceId;
  endpointId: number;
  domain: string;
}

export interface DevicePatch {
  name?: string;
  roomId?: string | null;
  aliases?: string[];
  exposure?: Partial<ExposurePolicy>;
}

export interface HistoryPoint {
  ts: number;
  value: AttributeValue;
}

const HISTORY_RETENTION_MS = 30 * 24 * 3600 * 1000;

/**
 * Owns devices, rooms, entities and current state. Everything is held in memory and
 * written through to SQLite, so reads (HomeKit `get`, API, MCP) never touch the disk or the device.
 */
export class Registry {
  readonly #storage: Storage;
  readonly #bus: EventBus;
  readonly #devices = new Map<DeviceId, Device>();
  readonly #state = new Map<DeviceId, DeviceState>();
  readonly #rooms = new Map<string, Room>();
  readonly #entities = new Map<string, Entity>();
  readonly #entityByEndpoint = new Map<string, string>();

  constructor(storage: Storage, bus: EventBus) {
    this.#storage = storage;
    this.#bus = bus;
    this.#load();
  }

  #load(): void {
    for (const row of this.#storage.sql('SELECT data FROM devices').all() as { data: string }[]) {
      const device = JSON.parse(row.data) as Device;
      // Nothing is known about reachability until the adapter reports in.
      device.availability = 'unknown';
      this.#devices.set(device.id, device);
    }
    for (const row of this.#storage.sql('SELECT * FROM state_current').all() as Record<string, string | number>[]) {
      this.#writeState(String(row.device_id), Number(row.endpoint_id), String(row.capability), String(row.attribute), JSON.parse(String(row.value)));
    }
    for (const row of this.#storage.sql('SELECT * FROM rooms ORDER BY sort_order, name').all() as Record<string, string | number>[]) {
      this.#rooms.set(String(row.id), { id: String(row.id), name: String(row.name), aliases: JSON.parse(String(row.aliases)), sortOrder: Number(row.sort_order) });
    }
    for (const row of this.#storage.sql('SELECT * FROM entities').all() as Record<string, string | number>[]) {
      const device = this.#devices.get(String(row.device_id));
      const endpoint = device?.endpoints.find((e) => e.id === Number(row.endpoint_id));
      const entity: Entity = {
        entityId: String(row.entity_id),
        deviceId: String(row.device_id),
        endpointId: Number(row.endpoint_id),
        domain: endpoint ? domainForDeviceType(endpoint.deviceType) : String(row.entity_id).split('.')[0]!,
      };
      this.#entities.set(entity.entityId, entity);
      this.#entityByEndpoint.set(`${entity.deviceId}#${entity.endpointId}`, entity.entityId);
    }
  }

  // ---------------------------------------------------------------- devices

  listDevices(): Device[] {
    return [...this.#devices.values()];
  }

  getDevice(id: DeviceId): Device | undefined {
    return this.#devices.get(id);
  }

  requireDevice(id: DeviceId): Device {
    const device = this.#devices.get(id);
    if (!device) throw new LivynqError('NOT_FOUND', `Device not found: ${id}`);
    return device;
  }

  /** Stable numeric endpoint id for an adapter-specific key (e.g. an MQTT unique_id). */
  endpointId(deviceId: DeviceId, key: string): number {
    const existing = this.#storage.sql('SELECT endpoint_id FROM endpoint_ids WHERE device_id = ? AND key = ?').get(deviceId, key) as
      | { endpoint_id: number }
      | undefined;
    if (existing) return existing.endpoint_id;
    const max = this.#storage.sql('SELECT MAX(endpoint_id) AS m FROM endpoint_ids WHERE device_id = ?').get(deviceId) as { m: number | null };
    const id = (max.m ?? 0) + 1;
    this.#storage.sql('INSERT INTO endpoint_ids (device_id, key, endpoint_id) VALUES (?, ?, ?)').run(deviceId, key, id);
    return id;
  }

  /** Called by adapters. Adapter-owned fields are refreshed; user-owned fields (room, aliases, renamed name, exposure) are kept. */
  upsertFromAdapter(adapter: string, def: DeviceDefinition): Device {
    this.#validateDefinition(def);
    const now = Date.now();
    const previous = this.#devices.get(def.id);
    if (previous && previous.adapter !== adapter) {
      throw new LivynqError('CONFLICT', `Device ${def.id} is owned by adapter ${previous.adapter}`);
    }
    const device: Device = {
      ...def,
      info: def.info ?? {},
      adapter,
      name: previous?.nameByUser ? previous.name : def.name,
      nameByUser: previous?.nameByUser ?? false,
      roomId: previous ? previous.roomId : this.#roomIdForSuggestion(def.suggestedRoom),
      aliases: previous?.aliases ?? [],
      availability: previous?.availability ?? 'unknown',
      exposure: previous?.exposure ?? defaultExposure(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (previous && sameDefinition(previous, device)) return previous;
    this.#devices.set(device.id, device);
    this.#persistDevice(device);
    this.#ensureEntities(device);
    this.#bus.emit(previous ? 'device.updated' : 'device.added', device);
    return device;
  }

  updateDevice(id: DeviceId, patch: DevicePatch): Device {
    const device = { ...this.requireDevice(id) };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new LivynqError('INVALID_PARAMS', 'name must not be empty');
      device.name = name;
      device.nameByUser = true;
    }
    if (patch.roomId !== undefined) {
      if (patch.roomId !== null && !this.#rooms.has(patch.roomId)) throw new LivynqError('NOT_FOUND', `Room not found: ${patch.roomId}`);
      device.roomId = patch.roomId;
    }
    if (patch.aliases !== undefined) device.aliases = patch.aliases.map((a) => a.trim()).filter(Boolean);
    if (patch.exposure !== undefined) device.exposure = { ...device.exposure, ...patch.exposure };
    device.updatedAt = Date.now();
    this.#devices.set(id, device);
    this.#persistDevice(device);
    this.#bus.emit('device.updated', device);
    return device;
  }

  removeDevice(id: DeviceId): void {
    this.requireDevice(id);
    this.#storage.transaction(() => {
      this.#storage.sql('DELETE FROM devices WHERE id = ?').run(id);
      this.#storage.sql('DELETE FROM state_current WHERE device_id = ?').run(id);
      this.#storage.sql('DELETE FROM entities WHERE device_id = ?').run(id);
      // endpoint_ids are kept on purpose: a re-added device gets the same endpoint ids (and HomeKit ids).
    });
    this.#devices.delete(id);
    this.#state.delete(id);
    for (const [entityId, entity] of this.#entities) {
      if (entity.deviceId === id) {
        this.#entities.delete(entityId);
        this.#entityByEndpoint.delete(`${entity.deviceId}#${entity.endpointId}`);
      }
    }
    this.#bus.emit('device.removed', { id });
  }

  setAvailability(id: DeviceId, availability: Availability): void {
    const device = this.#devices.get(id);
    if (!device || device.availability === availability) return;
    device.availability = availability;
    this.#bus.emit('availability', { deviceId: id, availability });
  }

  #validateDefinition(def: DeviceDefinition): void {
    if (!def.id || !/^[a-z0-9_-]+:.+/.test(def.id)) {
      throw new LivynqError('INVALID_PARAMS', `Device id must look like "<protocol>:<id>", got "${def.id}"`);
    }
    const seen = new Set<number>();
    for (const ep of def.endpoints) {
      if (seen.has(ep.id)) throw new LivynqError('INVALID_PARAMS', `Duplicate endpoint ${ep.id} on ${def.id}`);
      seen.add(ep.id);
      if (!getDeviceType(ep.deviceType)) throw new LivynqError('INVALID_PARAMS', `Unknown device type ${ep.deviceType}`);
      for (const cap of ep.capabilities) {
        if (!getCapability(cap)) throw new LivynqError('INVALID_PARAMS', `Unknown capability ${cap}`);
      }
    }
  }

  #persistDevice(device: Device): void {
    const { availability: _availability, ...persisted } = device;
    this.#storage
      .sql('INSERT INTO devices (id, data, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(device.id, JSON.stringify(persisted), device.createdAt, device.updatedAt);
  }

  // ---------------------------------------------------------------- entities

  #ensureEntities(device: Device): void {
    for (const ep of device.endpoints) {
      const key = `${device.id}#${ep.id}`;
      if (this.#entityByEndpoint.has(key)) continue;
      const domain = domainForDeviceType(ep.deviceType);
      const base = suggestEntityId(domain, {
        name: device.name,
        endpointName: device.endpoints.length > 1 ? ep.name ?? String(ep.id) : undefined,
        fallback: `${device.id.replace(':', ' ')} ${device.endpoints.length > 1 ? ep.id : ''}`,
      });
      let entityId = base;
      for (let n = 2; this.#entities.has(entityId); n++) entityId = `${base}_${n}`;
      this.#storage.sql('INSERT INTO entities (entity_id, device_id, endpoint_id) VALUES (?, ?, ?)').run(entityId, device.id, ep.id);
      const entity: Entity = { entityId, deviceId: device.id, endpointId: ep.id, domain };
      this.#entities.set(entityId, entity);
      this.#entityByEndpoint.set(key, entityId);
    }
  }

  listEntities(): Entity[] {
    return [...this.#entities.values()];
  }

  getEntity(entityId: string): Entity | undefined {
    return this.#entities.get(entityId);
  }

  entityIdFor(deviceId: DeviceId, endpointId: number): string | undefined {
    return this.#entityByEndpoint.get(`${deviceId}#${endpointId}`);
  }

  renameEntity(entityId: string, newEntityId: string): Entity {
    const entity = this.#entities.get(entityId);
    if (!entity) throw new LivynqError('NOT_FOUND', `Entity not found: ${entityId}`);
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(newEntityId) || !newEntityId.startsWith(`${entity.domain}.`)) {
      throw new LivynqError('INVALID_PARAMS', `Entity id must look like "${entity.domain}.object_id"`);
    }
    if (this.#entities.has(newEntityId)) throw new LivynqError('CONFLICT', `Entity id already used: ${newEntityId}`);
    this.#storage.sql('UPDATE entities SET entity_id = ? WHERE entity_id = ?').run(newEntityId, entityId);
    this.#entities.delete(entityId);
    const renamed = { ...entity, entityId: newEntityId };
    this.#entities.set(newEntityId, renamed);
    this.#entityByEndpoint.set(`${entity.deviceId}#${entity.endpointId}`, newEntityId);
    const device = this.#devices.get(entity.deviceId);
    if (device) this.#bus.emit('device.updated', device);
    return renamed;
  }

  // ---------------------------------------------------------------- state

  getState(id: DeviceId): DeviceState {
    return this.#state.get(id) ?? {};
  }

  getAttribute(id: DeviceId, endpointId: number, capability: string, attribute: string): AttributeValue | undefined {
    return this.#state.get(id)?.[endpointId]?.[capability]?.[attribute];
  }

  /** Applies attribute updates and emits one `state` event per changed attribute. */
  updateState(id: DeviceId, endpointId: number, capability: string, attributes: Record<string, AttributeValue>, source: string): StateChange[] {
    const device = this.#devices.get(id);
    if (!device) throw new LivynqError('NOT_FOUND', `Device not found: ${id}`);
    const endpoint = device.endpoints.find((e) => e.id === endpointId);
    if (!endpoint?.capabilities.includes(capability as never)) {
      throw new LivynqError('NOT_SUPPORTED', `Endpoint ${endpointId} of ${id} has no capability ${capability}`);
    }
    const definition = getCapability(capability)!;
    const ts = Date.now();
    const changes: StateChange[] = [];
    for (const [attribute, value] of Object.entries(attributes)) {
      if (!(attribute in definition.attributes)) throw new LivynqError('INVALID_PARAMS', `Unknown attribute ${capability}.${attribute}`);
      const oldValue = this.getAttribute(id, endpointId, capability, attribute);
      if (oldValue === value) continue;
      this.#writeState(id, endpointId, capability, attribute, value);
      changes.push({ deviceId: id, endpointId, capability, attribute, value, oldValue, ts, source });
    }
    if (changes.length) {
      this.#storage.transaction(() => {
        for (const c of changes) {
          const json = JSON.stringify(c.value);
          this.#storage
            .sql('INSERT INTO state_current (device_id, endpoint_id, capability, attribute, value, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value, ts = excluded.ts')
            .run(c.deviceId, c.endpointId, c.capability, c.attribute, json, c.ts);
          if (typeof c.value === 'number' || typeof c.value === 'boolean') {
            this.#storage
              .sql('INSERT INTO state_history (device_id, endpoint_id, capability, attribute, value, ts) VALUES (?, ?, ?, ?, ?, ?)')
              .run(c.deviceId, c.endpointId, c.capability, c.attribute, json, c.ts);
          }
        }
      });
      for (const c of changes) this.#bus.emit('state', c);
    }
    return changes;
  }

  #writeState(id: DeviceId, endpointId: number, capability: string, attribute: string, value: AttributeValue): void {
    let deviceState = this.#state.get(id);
    if (!deviceState) this.#state.set(id, (deviceState = {}));
    const ep = (deviceState[endpointId] ??= {});
    const cap = (ep[capability] ??= {});
    cap[attribute] = value;
  }

  history(id: DeviceId, endpointId: number, capability: string, attribute: string, from: number, to: number, limit = 2000): HistoryPoint[] {
    const rows = this.#storage
      .sql('SELECT ts, value FROM state_history WHERE device_id = ? AND endpoint_id = ? AND capability = ? AND attribute = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?')
      .all(id, endpointId, capability, attribute, from, to, limit) as { ts: number; value: string }[];
    return rows.reverse().map((r) => ({ ts: r.ts, value: JSON.parse(r.value) as AttributeValue }));
  }

  pruneHistory(now = Date.now()): number {
    const result = this.#storage.sql('DELETE FROM state_history WHERE ts < ?').run(now - HISTORY_RETENTION_MS);
    return Number(result.changes);
  }

  // ---------------------------------------------------------------- rooms

  listRooms(): Room[] {
    return [...this.#rooms.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  getRoom(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  findRoom(nameOrId: string): Room | undefined {
    const needle = nameOrId.trim().toLowerCase();
    return (
      this.#rooms.get(nameOrId) ??
      this.listRooms().find((r) => r.name.toLowerCase() === needle || r.aliases.some((a) => a.toLowerCase() === needle))
    );
  }

  createRoom(input: { name: string; aliases?: string[]; sortOrder?: number }): Room {
    const name = input.name.trim();
    if (!name) throw new LivynqError('INVALID_PARAMS', 'Room name must not be empty');
    if (this.findRoom(name)) throw new LivynqError('CONFLICT', `Room already exists: ${name}`);
    const room: Room = { id: randomUUID(), name, aliases: input.aliases ?? [], sortOrder: input.sortOrder ?? this.#rooms.size };
    this.#saveRoom(room);
    return room;
  }

  updateRoom(id: string, patch: { name?: string; aliases?: string[]; sortOrder?: number }): Room {
    const room = this.#rooms.get(id);
    if (!room) throw new LivynqError('NOT_FOUND', `Room not found: ${id}`);
    const updated = { ...room, ...patch, name: patch.name?.trim() || room.name };
    this.#saveRoom(updated);
    return updated;
  }

  deleteRoom(id: string): void {
    if (!this.#rooms.has(id)) throw new LivynqError('NOT_FOUND', `Room not found: ${id}`);
    for (const device of this.#devices.values()) {
      if (device.roomId === id) this.updateDevice(device.id, { roomId: null });
    }
    this.#storage.sql('DELETE FROM rooms WHERE id = ?').run(id);
    this.#rooms.delete(id);
    this.#bus.emit('rooms.changed', this.listRooms());
  }

  #saveRoom(room: Room): void {
    this.#storage
      .sql('INSERT INTO rooms (id, name, aliases, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, sort_order = excluded.sort_order')
      .run(room.id, room.name, JSON.stringify(room.aliases), room.sortOrder);
    this.#rooms.set(room.id, room);
    this.#bus.emit('rooms.changed', this.listRooms());
  }

  #roomIdForSuggestion(suggestion: string | undefined): string | null {
    if (!suggestion?.trim()) return null;
    return (this.findRoom(suggestion) ?? this.createRoom({ name: suggestion })).id;
  }
}

function sameDefinition(a: Device, b: Device): boolean {
  return (
    a.name === b.name &&
    a.protocol === b.protocol &&
    JSON.stringify(a.info) === JSON.stringify(b.info) &&
    JSON.stringify(a.endpoints) === JSON.stringify(b.endpoints)
  );
}
