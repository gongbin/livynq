import { randomUUID } from 'node:crypto';
import { LivynqError, type Home } from '@livynq/core';
import type { AutomationEngine } from '@livynq/automation';
import { loadHaYaml, type YamlWarning } from './ha-yaml.ts';
import type { ConfigSource } from './source.ts';

// ------------------------------------------------------------------ HA storage shapes (subset)

interface HaArea { id: string; name: string; aliases?: string[]; floor_id?: string | null }
interface HaDevice {
  id: string;
  name: string | null;
  name_by_user: string | null;
  manufacturer: string | null;
  model: string | null;
  area_id: string | null;
  identifiers: [string, string][];
  disabled_by: string | null;
}
interface HaEntity {
  entity_id: string;
  unique_id: string;
  platform: string;
  device_id: string | null;
  area_id: string | null;
  name: string | null;
  aliases?: string[];
  disabled_by: string | null;
}

// ------------------------------------------------------------------ plan

export type Operation =
  | { op: 'createRoom'; areaId: string; name: string; aliases: string[] }
  | { op: 'addRoomAliases'; roomId: string; aliases: string[] }
  | { op: 'patchDevice'; deviceId: string; areaId?: string; name?: string; aliases?: string[] }
  | { op: 'renameEntity'; from: string; to: string }
  | { op: 'createAutomation'; id: string; config: Record<string, unknown>; valid: boolean };

export interface DeviceReport {
  haDeviceId: string;
  name: string;
  manufacturer?: string;
  model?: string;
  area?: string;
  integration: string;
  status: 'matched' | 'pending' | 'unsupported';
  livynqDeviceId?: string;
  reason?: string;
  entities: { haEntityId: string; livynqEntityId?: string; status: 'same' | 'rename' | 'conflict' | 'missing' | 'skipped'; reason?: string }[];
}

export interface AutomationReport {
  id: string;
  alias: string;
  status: 'import' | 'invalid' | 'exists';
  errors: string[];
  missingEntities: string[];
}

export interface ImportPlan {
  source: string;
  haVersion?: string;
  location?: { latitude: number; longitude: number; timeZone?: string };
  rooms: { areaId: string; name: string; action: 'create' | 'match'; roomId?: string }[];
  devices: DeviceReport[];
  automations: AutomationReport[];
  notImported: { scripts: number; scenes: number; blueprints: number; floors: number };
  warnings: string[];
  operations: Operation[];
  summary: { rooms: number; devicesMatched: number; devicesPending: number; devicesUnsupported: number; entityRenames: number; automations: number; automationsInvalid: number };
}

const SUPPORTED_DOMAINS = new Set(['light', 'switch', 'sensor', 'binary_sensor']);

const INTEGRATION_NOTES: Record<string, string> = {
  zha: 'ZHA Zigbee: move the stick to the Livynq Zigbee integration (devices are re-paired), or run Zigbee2MQTT',
  zwave_js: 'Z-Wave JS: use the stick with the Livynq Z-Wave integration; copy the S2/S0 keys into plugin-data/zwave/keys.json to keep secure devices',
  matter: 'Matter: share the device from the Home Assistant app (multi-admin) and add it in Livynq with the pairing code',
  esphome: 'ESPHome: add the node in Livynq (Add device → ESPHome) with its API encryption key',
  shelly: 'Shelly: add the device in Livynq (Add device → Shelly)',
  xiaomi_home: 'Xiaomi Home: sign in with the Mi Home app in Livynq (Add device → Xiaomi / Mijia); Wi-Fi devices are then controlled locally',
  xiaomi_miot: 'Xiaomi MIoT: sign in with the Mi Home app in Livynq (Add device → Xiaomi / Mijia)',
  xiaomi_aqara: 'Aqara gateway devices: pair Aqara Zigbee devices directly with a Zigbee coordinator, or use the Xiaomi plugin with cloud access',
  hue: 'Philips Hue: pair the bridge in Livynq (Add device → Philips Hue); Home Assistant can stay paired too',
  homekit_controller: 'HomeKit controller: not supported yet',
};

function readStorage<T>(source: ConfigSource, name: string, warnings: string[]): T[] {
  const text = source.read(`.storage/${name}`);
  if (!text) {
    warnings.push(`.storage/${name} not found`);
    return [];
  }
  try {
    const data = (JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {};
    const key = Object.keys(data).find((k) => Array.isArray(data[k]));
    return key ? (data[key] as T[]) : [];
  } catch {
    warnings.push(`.storage/${name} is not valid JSON`);
    return [];
  }
}

/** Mirrors MqttAdapter's device id derivation from discovery `device.identifiers[0]`. */
const mqttDeviceId = (identifier: string) => `mqtt:${identifier.replace(/[^A-Za-z0-9_.:-]/g, '_')}`;

/** Read-only analysis: what an import would do. Safe to run any number of times. */
export function planImport(home: Home, engine: AutomationEngine | undefined, source: ConfigSource): ImportPlan {
  const warnings: string[] = [];
  const operations: Operation[] = [];
  const areas = readStorage<HaArea>(source, 'core.area_registry', warnings);
  const devices = readStorage<HaDevice>(source, 'core.device_registry', warnings);
  const entities = readStorage<HaEntity>(source, 'core.entity_registry', warnings);
  const floors = readStorage<{ floor_id: string }>(source, 'core.floor_registry', []);
  const areaName = new Map(areas.map((a) => [a.id, a.name]));

  // Rooms: match by name/alias, otherwise create. The HA area id becomes an alias so `area_id:` targets resolve.
  const rooms: ImportPlan['rooms'] = [];
  for (const area of areas) {
    const existing = home.registry.findRoom(area.name) ?? home.registry.findRoom(area.id);
    if (existing) {
      const missing = [area.id, ...(area.aliases ?? [])].filter((a) => a !== existing.name && !existing.aliases.includes(a));
      if (missing.length) operations.push({ op: 'addRoomAliases', roomId: existing.id, aliases: missing });
      rooms.push({ areaId: area.id, name: area.name, action: 'match', roomId: existing.id });
    } else {
      operations.push({ op: 'createRoom', areaId: area.id, name: area.name, aliases: [area.id, ...(area.aliases ?? [])].filter((a) => a !== area.name) });
      rooms.push({ areaId: area.id, name: area.name, action: 'create' });
    }
  }

  // Devices and entities
  const plannedEntityIds = new Set(home.registry.listEntities().map((e) => e.entityId));
  const entitiesByDevice = new Map<string, HaEntity[]>();
  for (const e of entities) if (e.device_id) entitiesByDevice.set(e.device_id, [...(entitiesByDevice.get(e.device_id) ?? []), e]);
  const deviceReports: DeviceReport[] = [];

  for (const d of devices) {
    if (d.disabled_by) continue;
    const integration = d.identifiers[0]?.[0] ?? 'unknown';
    const report: DeviceReport = {
      haDeviceId: d.id,
      name: d.name_by_user ?? d.name ?? d.id,
      ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
      ...(d.model ? { model: d.model } : {}),
      ...(d.area_id ? { area: areaName.get(d.area_id) ?? d.area_id } : {}),
      integration,
      status: 'unsupported',
      entities: [],
    };
    deviceReports.push(report);
    const haEntities = entitiesByDevice.get(d.id) ?? [];
    const mqttIdentifier = d.identifiers.find(([domain]) => domain === 'mqtt')?.[1];
    if (!mqttIdentifier) {
      report.reason = INTEGRATION_NOTES[integration] ?? `${integration}: not supported yet; keep it in Home Assistant (HA bridge arrives in M2)`;
      report.entities = haEntities.map((e) => ({ haEntityId: e.entity_id, status: 'skipped' }));
      continue;
    }
    const deviceId = mqttDeviceId(mqttIdentifier);
    report.livynqDeviceId = deviceId;
    const device = home.registry.getDevice(deviceId);
    if (!device) {
      report.status = 'pending';
      report.reason = 'Not discovered by Livynq yet: connect Livynq to the same MQTT broker, then run the import again';
      report.entities = haEntities.map((e) => ({ haEntityId: e.entity_id, status: 'missing' }));
      continue;
    }
    report.status = 'matched';

    const aliases = [...new Set(haEntities.flatMap((e) => e.aliases ?? []).filter((a) => !device.aliases.includes(a)))];
    const areaId = d.area_id ?? haEntities.find((e) => e.area_id)?.area_id ?? undefined;
    const patch: Extract<Operation, { op: 'patchDevice' }> = { op: 'patchDevice', deviceId };
    if (d.name_by_user && d.name_by_user !== device.name) patch.name = d.name_by_user;
    if (areaId) {
      const currentRoom = device.roomId ? home.registry.getRoom(device.roomId) : undefined;
      if (!currentRoom || (currentRoom.name !== areaName.get(areaId) && !currentRoom.aliases.includes(areaId))) patch.areaId = areaId;
    }
    if (aliases.length) patch.aliases = [...device.aliases, ...aliases];
    if (patch.name || patch.areaId || patch.aliases) operations.push(patch);

    for (const e of haEntities) {
      const domain = e.entity_id.split('.')[0]!;
      if (e.platform !== 'mqtt' || !SUPPORTED_DOMAINS.has(domain)) {
        report.entities.push({ haEntityId: e.entity_id, status: 'skipped', reason: SUPPORTED_DOMAINS.has(domain) ? `platform ${e.platform}` : `domain ${domain} not supported yet` });
        continue;
      }
      const endpointId = home.registry.findEndpointId(deviceId, e.unique_id);
      const current = endpointId === undefined ? undefined : home.registry.entityIdFor(deviceId, endpointId);
      if (!current) {
        report.entities.push({ haEntityId: e.entity_id, status: 'missing', reason: 'not discovered by Livynq (type not supported yet, or not published since Livynq connected)' });
        continue;
      }
      if (current === e.entity_id) {
        report.entities.push({ haEntityId: e.entity_id, livynqEntityId: current, status: 'same' });
        continue;
      }
      if (current.split('.')[0] !== domain) {
        report.entities.push({ haEntityId: e.entity_id, livynqEntityId: current, status: 'conflict', reason: 'different domain' });
        continue;
      }
      if (plannedEntityIds.has(e.entity_id)) {
        report.entities.push({ haEntityId: e.entity_id, livynqEntityId: current, status: 'conflict', reason: `${e.entity_id} is already used in Livynq` });
        continue;
      }
      plannedEntityIds.delete(current);
      plannedEntityIds.add(e.entity_id);
      operations.push({ op: 'renameEntity', from: current, to: e.entity_id });
      report.entities.push({ haEntityId: e.entity_id, livynqEntityId: current, status: 'rename' });
    }
  }

  // Automations
  const yamlWarnings: YamlWarning[] = [];
  const configuration = (loadHaYaml(source, 'configuration.yaml', yamlWarnings) ?? {}) as Record<string, unknown>;
  const automationConfigs: unknown[] = [];
  const automationKeys = Object.keys(configuration).filter((k) => k === 'automation' || k.startsWith('automation '));
  if (automationKeys.length) for (const k of automationKeys) automationConfigs.push(...[configuration[k]].flat());
  else if (source.read('automations.yaml') !== undefined) automationConfigs.push(...[loadHaYaml(source, 'automations.yaml', yamlWarnings)].flat());
  for (const w of yamlWarnings) warnings.push(`${w.file}: ${w.message}`);

  const automationReports: AutomationReport[] = [];
  const existingAutomations = new Set(engine?.list().map((a) => a.id) ?? []);
  for (const raw of automationConfigs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const config = raw as Record<string, unknown>;
    if ('use_blueprint' in config) {
      automationReports.push({ id: String(config.id ?? '?'), alias: String(config.alias ?? '?'), status: 'invalid', errors: ['blueprint-based automations are not supported yet'], missingEntities: [] });
      continue;
    }
    const validation = engine?.validate(config) ?? { ok: false, errors: ['automation engine disabled'], automation: undefined };
    const id = validation.automation?.id ?? (config.id !== undefined ? String(config.id) : slug(String(config.alias ?? '')));
    const alias = String(config.alias ?? id);
    const missingEntities = [...new Set(referencedEntities(config))].filter((e) => !plannedEntityIds.has(e) && !e.startsWith('automation.'));
    if (existingAutomations.has(id)) {
      automationReports.push({ id, alias, status: 'exists', errors: [], missingEntities });
      continue;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      automationReports.push({ id, alias, status: 'invalid', errors: ['cannot derive an id (give it an id or an English alias)'], missingEntities });
      continue;
    }
    automationReports.push({ id, alias, status: validation.ok ? 'import' : 'invalid', errors: validation.errors, missingEntities });
    operations.push({ op: 'createAutomation', id, config: { ...config, id }, valid: validation.ok });
  }

  // Location & leftovers
  let location: ImportPlan['location'];
  const coreConfig = source.read('.storage/core.config');
  if (coreConfig) {
    const data = (JSON.parse(coreConfig) as { data?: { latitude?: number; longitude?: number; time_zone?: string } }).data;
    if (data && Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) location = { latitude: data.latitude!, longitude: data.longitude!, timeZone: data.time_zone };
  }
  const count = (key: string) => {
    const v = configuration[key];
    return Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
  };
  const blueprints = source.list('blueprints/automation').length + source.list('blueprints/script').length;

  return {
    source: source.description,
    haVersion: source.read('.HA_VERSION')?.trim(),
    location,
    rooms,
    devices: deviceReports,
    automations: automationReports,
    notImported: { scripts: count('script'), scenes: count('scene'), blueprints, floors: floors.length },
    warnings,
    operations,
    summary: {
      rooms: rooms.length,
      devicesMatched: deviceReports.filter((d) => d.status === 'matched').length,
      devicesPending: deviceReports.filter((d) => d.status === 'pending').length,
      devicesUnsupported: deviceReports.filter((d) => d.status === 'unsupported').length,
      entityRenames: operations.filter((o) => o.op === 'renameEntity').length,
      automations: automationReports.filter((a) => a.status === 'import').length,
      automationsInvalid: automationReports.filter((a) => a.status === 'invalid').length,
    },
  };
}

function slug(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

/** Entity ids referenced anywhere under `entity_id` keys. */
function referencedEntities(value: unknown, key?: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => referencedEntities(v, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => referencedEntities(v, k));
  if (key === 'entity_id' && typeof value === 'string') return value.split(',').map((s) => s.trim()).filter((s) => /^[a-z_]+\.[a-z0-9_]+$/.test(s));
  return [];
}

// ------------------------------------------------------------------ apply / revert

type Undo =
  | { op: 'deleteRoom'; roomId: string }
  | { op: 'setRoomAliases'; roomId: string; aliases: string[] }
  | { op: 'restoreDevice'; deviceId: string; name: string; nameByUser: boolean; roomId: string | null; aliases: string[] }
  | { op: 'renameEntity'; from: string; to: string }
  | { op: 'deleteAutomation'; id: string };

export interface ImportRecord {
  id: string;
  source: string;
  createdAt: number;
  createdBy: string;
  revertedAt: number | null;
  summary: ImportPlan['summary'];
  applied: { operations: number; failed: { operation: Operation; error: string }[] };
}

export interface ApplyOptions {
  /** Imported automations start disabled unless set (avoid double-firing while HA still runs). */
  enableAutomations?: boolean;
}

export function applyImport(home: Home, engine: AutomationEngine | undefined, plan: ImportPlan, createdBy: string, options: ApplyOptions = {}): ImportRecord {
  const undo: Undo[] = [];
  const failed: ImportRecord['applied']['failed'] = [];
  const roomForArea = new Map<string, string>(plan.rooms.filter((r) => r.roomId).map((r) => [r.areaId, r.roomId!]));
  for (const operation of plan.operations) {
    try {
      switch (operation.op) {
        case 'createRoom': {
          const room = home.registry.findRoom(operation.name) ?? home.registry.createRoom({ name: operation.name, aliases: operation.aliases });
          roomForArea.set(operation.areaId, room.id);
          undo.push({ op: 'deleteRoom', roomId: room.id });
          break;
        }
        case 'addRoomAliases': {
          const room = home.registry.getRoom(operation.roomId);
          if (!room) throw new Error('room disappeared');
          undo.push({ op: 'setRoomAliases', roomId: room.id, aliases: room.aliases });
          home.registry.updateRoom(room.id, { aliases: [...new Set([...room.aliases, ...operation.aliases])] });
          break;
        }
        case 'patchDevice': {
          const device = home.registry.requireDevice(operation.deviceId);
          undo.push({ op: 'restoreDevice', deviceId: device.id, name: device.name, nameByUser: device.nameByUser, roomId: device.roomId, aliases: device.aliases });
          const roomId = operation.areaId ? (roomForArea.get(operation.areaId) ?? home.registry.findRoom(operation.areaId)?.id) : undefined;
          home.registry.updateDevice(device.id, { name: operation.name, roomId, aliases: operation.aliases });
          break;
        }
        case 'renameEntity':
          home.registry.renameEntity(operation.from, operation.to);
          undo.push({ op: 'renameEntity', from: operation.to, to: operation.from });
          break;
        case 'createAutomation':
          if (!engine) throw new Error('automation engine disabled');
          engine.save(operation.config, 'import:homeassistant', { onlyCreate: true, enabled: Boolean(options.enableAutomations) && operation.valid, allowInvalid: true });
          undo.push({ op: 'deleteAutomation', id: operation.id });
          break;
      }
    } catch (err) {
      failed.push({ operation, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const record: ImportRecord = {
    id: randomUUID(),
    source: plan.source,
    createdAt: Date.now(),
    createdBy,
    revertedAt: null,
    summary: plan.summary,
    applied: { operations: plan.operations.length - failed.length, failed },
  };
  home.storage
    .sql('INSERT INTO imports (id, source, created_at, created_by, report, undo) VALUES (?, ?, ?, ?, ?, ?)')
    .run(record.id, `homeassistant:${plan.source}`, record.createdAt, createdBy, JSON.stringify({ summary: plan.summary, applied: record.applied }), JSON.stringify(undo));
  home.log.info({ importId: record.id, ...plan.summary, failed: failed.length }, 'Home Assistant import applied');
  return record;
}

export function listImports(home: Home): ImportRecord[] {
  return (home.storage.sql('SELECT * FROM imports ORDER BY created_at DESC').all() as Record<string, string | number | null>[]).map((r) => {
    const report = JSON.parse(String(r.report)) as Pick<ImportRecord, 'summary' | 'applied'>;
    return {
      id: String(r.id),
      source: String(r.source),
      createdAt: Number(r.created_at),
      createdBy: String(r.created_by),
      revertedAt: r.reverted_at === null ? null : Number(r.reverted_at),
      ...report,
    };
  });
}

/** Undoes an import in reverse order. Steps whose target changed since are skipped and reported. */
export function revertImport(home: Home, engine: AutomationEngine | undefined, importId: string): { reverted: number; skipped: string[] } {
  const row = home.storage.sql('SELECT undo, reverted_at FROM imports WHERE id = ?').get(importId) as { undo: string; reverted_at: number | null } | undefined;
  if (!row) throw new LivynqError('NOT_FOUND', `Import not found: ${importId}`);
  if (row.reverted_at) throw new LivynqError('CONFLICT', 'Import already reverted');
  const steps = (JSON.parse(row.undo) as Undo[]).reverse();
  const skipped: string[] = [];
  let reverted = 0;
  for (const step of steps) {
    try {
      switch (step.op) {
        case 'deleteAutomation':
          engine?.remove(step.id);
          break;
        case 'renameEntity':
          home.registry.renameEntity(step.from, step.to);
          break;
        case 'restoreDevice':
          home.registry.updateDevice(step.deviceId, { name: step.name, roomId: step.roomId, aliases: step.aliases, nameByUser: step.nameByUser });
          break;
        case 'setRoomAliases':
          home.registry.updateRoom(step.roomId, { aliases: step.aliases });
          break;
        case 'deleteRoom':
          home.registry.deleteRoom(step.roomId);
          break;
      }
      reverted++;
    } catch (err) {
      skipped.push(`${step.op}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  home.storage.sql('UPDATE imports SET reverted_at = ? WHERE id = ?').run(Date.now(), importId);
  return { reverted, skipped };
}
