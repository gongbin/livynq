import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { Confirmations } from './confirmations.ts';
import { Settings } from './settings.ts';
import { Spaces } from './spaces.ts';

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
  readonly confirmations: Confirmations;
  readonly settings: Settings;
  readonly spaces: Spaces;
  readonly startedAt = Date.now();

  readonly #adapters = new Map<string, Adapter>();
  readonly #exporters = new Map<string, Exporter>();
  readonly #extensions = new Map<string, Exporter>();
  readonly #handlers = new Map<string, { adapter: string; handlers: Record<string, CommandHandler> }>();
  readonly #actions = new Map<string, Map<string, { description: string; handler: (params: Record<string, unknown>) => unknown }>>();
  readonly #commandTimeoutMs: number;
  #pruneTimer: NodeJS.Timeout | undefined;
  #confirmationTimer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(options: HomeOptions) {
    this.dataDir = options.dataDir;
    this.log = options.logger ?? silentLogger;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.storage = new Storage(options.dataDir === ':memory:' ? ':memory:' : join(options.dataDir, 'livynq.db'));
    this.bus = new EventBus((err, event) => this.log.error({ err, event }, 'event listener failed'));
    this.registry = new Registry(this.storage, this.bus);
    this.tokens = new TokenStore(this.storage);
    this.confirmations = new Confirmations(this);
    this.settings = new Settings(this.storage, this.bus);
    this.spaces = new Spaces(this.storage, this.bus, this.registry);
  }

  get running(): boolean {
    return this.#running;
  }

  useAdapter(adapter: Adapter): this {
    if (this.#adapters.has(adapter.id)) throw new Error(`Adapter ${adapter.id} already registered`);
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  /** Stops and unregisters an adapter (plugin disabled or reconfigured); its devices stay, offline. */
  async removeAdapter(id: string): Promise<void> {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new LivynqError('NOT_FOUND', `Adapter not found: ${id}`);
    await this.#guard(`stop adapter ${id}`, () => adapter.stop());
    this.#adapters.delete(id);
    this.#actions.delete(id);
    for (const key of [...this.#handlers.keys()]) if (this.#handlers.get(key)?.adapter === id) this.#handlers.delete(key);
    for (const device of this.registry.listDevices()) if (device.adapter === id) this.registry.setAvailability(device.id, 'offline');
  }

  /** Registers an adapter and, when the home already runs, starts it right away (plugins enabled from the UI). */
  async addAdapter(adapter: Adapter): Promise<void> {
    this.useAdapter(adapter);
    if (this.#running) await this.#guard(`adapter ${adapter.id}`, () => adapter.start(this.#contextFor(adapter.id)));
  }

  useExporter(exporter: Exporter): this {
    if (this.#exporters.has(exporter.id)) throw new Error(`Exporter ${exporter.id} already registered`);
    this.#exporters.set(exporter.id, exporter);
    return this;
  }

  /** Extensions start after adapters (their first state reports are already in) and stop first. */
  useExtension(extension: Exporter): this {
    if (this.#extensions.has(extension.id)) throw new Error(`Extension ${extension.id} already registered`);
    this.#extensions.set(extension.id, extension);
    return this;
  }

  extension<T extends Exporter>(id: string): T | undefined {
    return this.#extensions.get(id) as T | undefined;
  }

  adapter<T extends Adapter>(id: string): T | undefined {
    return this.#adapters.get(id) as T | undefined;
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
    for (const extension of this.#extensions.values()) {
      await this.#guard(`extension ${extension.id}`, () => extension.start(this));
    }
    this.registry.pruneHistory();
    this.#pruneTimer = setInterval(() => this.registry.pruneHistory(), 6 * 3600 * 1000).unref();
    // Expire stale confirmations promptly so every UI hears about it.
    this.#confirmationTimer = setInterval(() => this.confirmations.list('pending'), 15_000).unref();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    clearInterval(this.#pruneTimer);
    clearInterval(this.#confirmationTimer);
    for (const extension of this.#extensions.values()) await this.#guard(`stop extension ${extension.id}`, () => extension.stop());
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
    const dataDir = this.dataDir === ':memory:' ? join(tmpdir(), `livynq-memory-${process.pid}`, adapterId) : join(this.dataDir, 'plugin-data', adapterId);
    mkdirSync(dataDir, { recursive: true });
    return {
      log,
      dataDir,
      upsertDevice: (def) => this.#handleFor(adapterId, this.registry.upsertFromAdapter(adapterId, def).id),
      removeDevice: (id) => {
        if (this.registry.getDevice(id)?.adapter !== adapterId) return;
        this.registry.removeDevice(id);
        for (const key of this.#handles(id)) this.#handlers.delete(key);
      },
      knownDevices: () => this.registry.listDevices().filter((d) => d.adapter === adapterId),
      deviceExists: (id) => Boolean(this.registry.getDevice(id)),
      registerAction: (name, description, handler) => {
        if (!/^[a-zA-Z][\w-]{0,40}$/.test(name)) throw new LivynqError('INVALID_PARAMS', `Invalid action name ${name}`);
        let map = this.#actions.get(adapterId);
        if (!map) this.#actions.set(adapterId, (map = new Map()));
        map.set(name, { description, handler });
      },
      deviceState: (id) => (this.registry.getDevice(id)?.adapter === adapterId ? this.registry.getState(id) : {}),
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

  // ---------------------------------------------------------------- plugin actions

  actions(adapterId: string): { name: string; description: string }[] {
    return [...(this.#actions.get(adapterId) ?? [])].map(([name, a]) => ({ name, description: a.description }));
  }

  async invokeAction(adapterId: string, name: string, params: Record<string, unknown>, source: string): Promise<unknown> {
    const action = this.#actions.get(adapterId)?.get(name);
    if (!action) {
      const status = (this.#adapters.get(adapterId) as { info?: () => { status: string } } | undefined)?.info?.().status;
      if (status && status !== 'running') throw new LivynqError('DEVICE_OFFLINE', `Plugin ${adapterId} is ${status}`, 'Check its error in the plugin list and restart it');
      throw new LivynqError('NOT_FOUND', `${adapterId} has no action "${name}"`, `Available: ${this.actions(adapterId).map((a) => a.name).join(', ') || 'none'}`);
    }
    this.log.info({ adapter: adapterId, action: name, source }, 'plugin action');
    try {
      return await action.handler(params);
    } catch (err) {
      // Plugin-reported failures (wrong pairing code, device unreachable…) are not server faults.
      throw err instanceof LivynqError && err.code !== 'INTERNAL' ? err : new LivynqError('ACTION_FAILED', err instanceof Error ? err.message : String(err));
    }
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
    case 'windowCovering.open':
      return { currentPosition: 100, targetPosition: 100, operationalStatus: 'stopped' };
    case 'windowCovering.close':
      return { currentPosition: 0, targetPosition: 0, operationalStatus: 'stopped' };
    case 'windowCovering.goToPosition':
      return { currentPosition: params.position as number, targetPosition: params.position as number, operationalStatus: 'stopped' };
    case 'windowCovering.stop':
      return { operationalStatus: 'stopped' };
    case 'thermostat.setSystemMode':
      return { systemMode: params.mode as string };
    case 'thermostat.setTargetTemperature':
      return { targetTemperature: params.temperature as number };
    case 'thermostat.setTemperatureRange':
      return { targetTemperatureLow: params.low as number, targetTemperatureHigh: params.high as number };
    case 'fanControl.setPercent':
      return { percentCurrent: params.percent as number };
    case 'fanControl.setMode':
      return { fanMode: params.mode as string };
    case 'doorLock.lock':
      return { lockState: 'locked' };
    case 'doorLock.unlock':
      return { lockState: 'unlocked' };
    default:
      return undefined;
  }
}
