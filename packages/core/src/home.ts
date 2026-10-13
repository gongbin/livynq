import { join } from 'node:path';
import {
  getCapability,
  getDeviceType,
  isEntityId,
  validate,
  type AttributeValue,
  type Device,
  type DeviceId,
} from '@livynq/model';
import type { Adapter, AdapterContext, CommandHandler, DeviceHandle, Exporter } from './adapter.ts';
import { EventBus } from './event-bus.ts';
import { LivynqError } from './errors.ts';
import { silentLogger, type Logger } from './logger.ts';
import { Registry } from './registry.ts';
import { Storage } from './storage.ts';
import { TokenStore } from './tokens.ts';

export interface HomeOptions {
  /** Data directory; `:memory:` keeps everything in memory (tests). */
  dataDir: string;
  logger?: Logger;
  commandTimeoutMs?: number;
}

export interface CommandRequest {
  deviceId: DeviceId;
  endpointId: number;
  capability: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface ResolvedTarget {
  device: Device;
  endpointId: number;
  entityId: string | undefined;
}

export interface DeviceQuery {
  text?: string;
  room?: string;
  domain?: string;
  capability?: string;
}

/** The running home: registry + bus + adapters + exporters + command routing. */
export class Home {
  readonly dataDir: string;
  readonly log: Logger;
  readonly storage: Storage;
  readonly bus: EventBus;
  readonly registry: Registry;
  readonly tokens: TokenStore;
  readonly startedAt = Date.now();

  readonly #adapters = new Map<string, Adapter>();
  readonly #exporters = new Map<string, Exporter>();
  readonly #handlers = new Map<string, { adapter: string; handlers: Record<string, CommandHandler> }>();
  readonly #commandTimeoutMs: number;
  #pruneTimer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: HomeOptions) {
    this.dataDir = options.dataDir;
    this.log = options.logger ?? silentLogger;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.storage = new Storage(options.dataDir === ':memory:' ? ':memory:' : join(options.dataDir, 'livynq.db'));
    this.bus = new EventBus((err, event) => this.log.error({ err, event }, 'event listener failed'));
    this.registry = new Registry(this.storage, this.bus);
    this.tokens = new TokenStore(this.storage);
  }

  get running(): boolean {
    return this.#running;
  }

  useAdapter(adapter: Adapter): this {
    if (this.#adapters.has(adapter.id)) throw new Error(`Adapter ${adapter.id} already registered`);
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  useExporter(exporter: Exporter): this {
    if (this.#exporters.has(exporter.id)) throw new Error(`Exporter ${exporter.id} already registered`);
    this.#exporters.set(exporter.id, exporter);
    return this;
  }

  adapters(): string[] {
    return [...this.#adapters.keys()];
  }

  exporter<T extends Exporter>(id: string): T | undefined {
    return this.#exporters.get(id) as T | undefined;
  }

  async start(): Promise<void> {
    this.#running = true;
    // Exporters first: they publish persisted devices immediately, so HomeKit accessories
    // never disappear while a slow adapter is still connecting.
    for (const exporter of this.#exporters.values()) {
      await this.#guard(`exporter ${exporter.id}`, () => exporter.start(this));
    }
    for (const adapter of this.#adapters.values()) {
      await this.#guard(`adapter ${adapter.id}`, () => adapter.start(this.#contextFor(adapter.id)));
    }
    this.registry.pruneHistory();
    this.#pruneTimer = setInterval(() => this.registry.pruneHistory(), 6 * 3600 * 1000).unref();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    clearInterval(this.#pruneTimer);
    for (const adapter of this.#adapters.values()) await this.#guard(`stop adapter ${adapter.id}`, () => adapter.stop());
    for (const exporter of this.#exporters.values()) await this.#guard(`stop exporter ${exporter.id}`, () => exporter.stop());
    this.storage.close();
  }

  async #guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // One failing integration must not take the whole home down.
      this.log.error({ err }, `${what} failed`);
    }
  }

  #contextFor(adapterId: string): AdapterContext {
    const log = this.log.child({ adapter: adapterId });
    return {
      log,
      dataDir: this.dataDir === ':memory:' ? this.dataDir : join(this.dataDir, 'plugin-data', adapterId),
      upsertDevice: (def) => this.#handleFor(adapterId, this.registry.upsertFromAdapter(adapterId, def).id),
      removeDevice: (id) => {
        if (this.registry.getDevice(id)?.adapter !== adapterId) return;
        this.registry.removeDevice(id);
        for (const key of this.#handles(id)) this.#handlers.delete(key);
      },
      knownDevices: () => this.registry.listDevices().filter((d) => d.adapter === adapterId),
      endpointId: (deviceId, key) => this.registry.endpointId(deviceId, key),
    };
  }

  #handles(deviceId: DeviceId): string[] {
    return [...this.#handlers.keys()].filter((k) => k.startsWith(`${deviceId}/`));
  }

  #handleFor(adapterId: string, id: DeviceId): DeviceHandle {
    const registry = this.registry;
    return {
      id,
      get device() {
        return registry.requireDevice(id);
      },
      update: (endpointId, capability, attributes) => {
        registry.updateState(id, endpointId, capability, attributes, `adapter:${adapterId}`);
      },
      get: (endpointId, capability, attribute) => registry.getAttribute(id, endpointId, capability, attribute),
      setAvailability: (availability) => registry.setAvailability(id, availability),
      handle: (endpointId, capability, handlers) => {
        this.#handlers.set(`${id}/${endpointId}/${capability}`, { adapter: adapterId, handlers });
      },
    };
  }

  // ---------------------------------------------------------------- commands

  /**
   * Validates and routes a command to the owning adapter. State is not assumed:
   * it changes when the adapter reports back, except for `assumedState` endpoints.
   */
  async command(request: CommandRequest, source: string): Promise<void> {
    const { deviceId, endpointId, capability, command } = request;
    const params = request.params ?? {};
    let error: LivynqError | undefined;
    try {
      const device = this.registry.requireDevice(deviceId);
      const endpoint = device.endpoints.find((e) => e.id === endpointId);
      if (!endpoint) throw new LivynqError('NOT_FOUND', `Endpoint ${endpointId} not found on ${deviceId}`);
      if (!endpoint.capabilities.includes(capability as never)) {
        throw new LivynqError('NOT_SUPPORTED', `${deviceId}#${endpointId} does not support ${capability}`, `Supported: ${endpoint.capabilities.join(', ')}`);
      }
      const definition = getCapability(capability)!;
      const schema = definition.commands[command];
      if (!schema) {
        throw new LivynqError('NOT_SUPPORTED', `${capability} has no command ${command}`, `Commands: ${Object.keys(definition.commands).join(', ') || 'none'}`);
      }
      const problems = validate(schema, params, 'params');
      if (problems.length) throw new LivynqError('INVALID_PARAMS', problems.join('; '));
      if (device.availability === 'offline') throw new LivynqError('DEVICE_OFFLINE', `${device.name} is offline`);
      const entry = this.#handlers.get(`${deviceId}/${endpointId}/${capability}`);
      const handler = entry?.handlers[command];
      if (!handler) throw new LivynqError('NOT_SUPPORTED', `No handler for ${capability}.${command} on ${deviceId}#${endpointId}`);

      await withTimeout(Promise.resolve(handler(params)), this.#commandTimeoutMs);
      if (endpoint.assumedState) {
        const current = this.registry.getState(deviceId)[endpointId]?.[capability] ?? {};
        const optimistic = optimisticState(capability, command, params, current);
        if (optimistic) this.registry.updateState(deviceId, endpointId, capability, optimistic, source);
      }
    } catch (err) {
      error = err instanceof LivynqError ? err : new LivynqError('INTERNAL', err instanceof Error ? err.message : String(err));
      throw error;
    } finally {
      this.storage
        .sql('INSERT INTO command_log (ts, source, device_id, endpoint_id, capability, command, params, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Date.now(), source, deviceId, endpointId, capability, command, JSON.stringify(params), error ? 0 : 1, error?.message ?? null);
      this.log.debug({ deviceId, endpointId, capability, command, source, ok: !error }, 'command');
    }
  }

  recentCommands(limit = 50): Record<string, unknown>[] {
    return (this.storage.sql('SELECT * FROM command_log ORDER BY ts DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => ({
      ...r,
      params: r.params ? JSON.parse(String(r.params)) : {},
      ok: r.ok === 1,
    }));
  }

  // ---------------------------------------------------------------- lookup

  /**
   * Resolves "light.kitchen", "zigbee:0x1234", "zigbee:0x1234#2" or a device name/alias.
   * When a capability is given, picks the first endpoint that supports it.
   */
  resolveTarget(ref: string, capability?: string): ResolvedTarget {
    const trimmed = ref.trim();
    if (isEntityId(trimmed)) {
      const entity = this.registry.getEntity(trimmed);
      if (entity) return { device: this.registry.requireDevice(entity.deviceId), endpointId: entity.endpointId, entityId: entity.entityId };
    }
    const hashAt = trimmed.lastIndexOf('#');
    const explicitEndpoint = hashAt > 0 && /^\d+$/.test(trimmed.slice(hashAt + 1)) ? Number(trimmed.slice(hashAt + 1)) : undefined;
    const deviceRef = explicitEndpoint === undefined ? trimmed : trimmed.slice(0, hashAt);
    const device = this.registry.getDevice(deviceRef) ?? this.#findByName(deviceRef);
    if (!device) throw new LivynqError('NOT_FOUND', `No device or entity matches "${ref}"`, 'List devices (MCP list_devices, `livynq devices list`) to see valid targets');
    let endpointId = explicitEndpoint;
    if (endpointId === undefined) {
      const candidates = capability ? device.endpoints.filter((e) => e.capabilities.includes(capability as never)) : device.endpoints;
      if (!candidates.length) throw new LivynqError('NOT_SUPPORTED', `${device.name} has no endpoint with ${capability}`);
      endpointId = candidates[0]!.id;
    } else if (!device.endpoints.some((e) => e.id === endpointId)) {
      throw new LivynqError('NOT_FOUND', `Endpoint ${endpointId} not found on ${device.id}`);
    }
    return { device, endpointId, entityId: this.registry.entityIdFor(device.id, endpointId) };
  }

  #findByName(name: string): Device | undefined {
    const needle = name.toLowerCase();
    const matches = this.registry
      .listDevices()
      .filter((d) => d.name.toLowerCase() === needle || d.aliases.some((a) => a.toLowerCase() === needle));
    if (matches.length > 1) {
      throw new LivynqError('CONFLICT', `"${name}" matches ${matches.length} devices`, matches.map((d) => d.id).join(', '));
    }
    return matches[0];
  }

  findDevices(query: DeviceQuery = {}): Device[] {
    const text = query.text?.trim().toLowerCase();
    const room = query.room ? this.registry.findRoom(query.room) : undefined;
    if (query.room && !room) return [];
    return this.registry.listDevices().filter((device) => {
      if (room && device.roomId !== room.id) return false;
      if (query.domain && !device.endpoints.some((e) => getDeviceType(e.deviceType)?.domain === query.domain)) return false;
      if (query.capability && !device.endpoints.some((e) => e.capabilities.includes(query.capability as never))) return false;
      if (text) {
        const roomName = device.roomId ? this.registry.getRoom(device.roomId)?.name ?? '' : '';
        const entityIds = device.endpoints.map((e) => this.registry.entityIdFor(device.id, e.id) ?? '');
        const haystack = [device.id, device.name, roomName, ...device.aliases, ...entityIds, device.info.manufacturer ?? '', device.info.model ?? '']
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LivynqError('TIMEOUT', `Device did not respond within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** State to assume after a command on devices that cannot report state. */
export function optimisticState(
  capability: string,
  command: string,
  params: Record<string, unknown>,
  current: Record<string, AttributeValue>,
): Record<string, AttributeValue> | undefined {
  switch (`${capability}.${command}`) {
    case 'onOff.on':
      return { onOff: true };
    case 'onOff.off':
      return { onOff: false };
    case 'onOff.toggle':
      return { onOff: !current.onOff };
    case 'levelControl.moveToLevel':
      return { currentLevel: params.level as number };
    case 'colorControl.moveToColorTemperature':
      return { colorTemperatureMireds: params.colorTemperatureMireds as number, colorMode: 'ct' };
    case 'colorControl.moveToHueAndSaturation':
      return { currentHue: params.hue as number, currentSaturation: params.saturation as number, colorMode: 'hs' };
    default:
      return undefined;
  }
}
