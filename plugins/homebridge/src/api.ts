import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { format } from 'node:util';
import type { Accessory, Service, SerializedAccessory } from 'hap-nodejs';
import { hap } from './hap.ts';

/**
 * The Homebridge plugin API (as of Homebridge 1.8, with the 2.0 additions plugins probe for),
 * implemented on top of the same hap-nodejs Homebridge uses. Plugins get `api` in their
 * initializer and platform constructors and never see a difference.
 */

/** The Homebridge version this layer behaves like. */
export const SERVER_VERSION = '1.8.5';
/** Homebridge's plugin API version for 1.8 */
export const API_VERSION = 2.7;

export const APIEvent = { DID_FINISH_LAUNCHING: 'didFinishLaunching', SHUTDOWN: 'shutdown' } as const;
export const PlatformAccessoryEvent = { IDENTIFY: 'identify' } as const;
export const PluginType = { ACCESSORY: 'accessory', PLATFORM: 'platform' } as const;
export const LogLevel = { INFO: 'info', SUCCESS: 'success', WARN: 'warn', ERROR: 'error', DEBUG: 'debug' } as const;

// ---------------------------------------------------------------- logger

export interface Sink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface Logging {
  (message: string, ...params: unknown[]): void;
  prefix: string;
  info(message: string, ...params: unknown[]): void;
  success(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
  debug(message: string, ...params: unknown[]): void;
  log(level: string, message: string, ...params: unknown[]): void;
}

export function createLogger(sink: Sink, prefix: string): Logging {
  const line = (message: unknown, params: unknown[]) => `[${prefix}] ${format(message, ...params)}`;
  const log = ((message: string, ...params: unknown[]) => sink.info(line(message, params))) as Logging;
  log.prefix = prefix;
  log.info = (m, ...p) => sink.info(line(m, p));
  log.success = (m, ...p) => sink.info(line(m, p));
  log.warn = (m, ...p) => sink.warn(line(m, p));
  log.error = (m, ...p) => sink.error(line(m, p));
  log.debug = (m, ...p) => sink.debug(line(m, p));
  log.log = (level, m, ...p) => (level === 'warn' ? log.warn : level === 'error' ? log.error : level === 'debug' ? log.debug : log.info)(m, ...p);
  return log;
}

// ---------------------------------------------------------------- PlatformAccessory

export interface SerializedPlatformAccessory extends SerializedAccessory {
  plugin: string;
  platform: string;
  context: Record<string, unknown>;
}

type ServiceCtor = (new (...args: never[]) => Service) & { UUID: string };

export class PlatformAccessory<T extends Record<string, unknown> = Record<string, unknown>> extends EventEmitter {
  /** @private */ _associatedPlugin?: string;
  /** @private */ _associatedPlatform?: string;
  /** @private */ _associatedHAPAccessory: Accessory;
  context: T = {} as T;
  /** @deprecated always true */
  reachable = true;

  constructor(displayName: string, uuid: string, category?: number) {
    super();
    this._associatedHAPAccessory = new hap.Accessory(displayName, uuid);
    if (category !== undefined) this._associatedHAPAccessory.category = category;
    this._associatedHAPAccessory.on('identify' as never, ((paired: boolean, callback: () => void) => {
      this.emit('identify', paired, () => {});
      callback?.();
    }) as never);
  }

  get displayName(): string {
    return this._associatedHAPAccessory.displayName;
  }
  set displayName(name: string) {
    this.updateDisplayName(name);
  }
  get UUID(): string {
    return this._associatedHAPAccessory.UUID;
  }
  get category(): number {
    return this._associatedHAPAccessory.category;
  }
  set category(c: number) {
    this._associatedHAPAccessory.category = c;
  }
  get services(): Service[] {
    return this._associatedHAPAccessory.services;
  }

  updateDisplayName(name: string): void {
    if (!name) return;
    (this._associatedHAPAccessory as unknown as { displayName: string }).displayName = name;
    this._associatedHAPAccessory.getService(hap.Service.AccessoryInformation)?.setCharacteristic(hap.Characteristic.Name, name);
  }

  /** @deprecated */
  updateReachability(reachable: boolean): void {
    this.reachable = reachable;
  }

  addService(service: Service | ServiceCtor, ...args: unknown[]): Service {
    const s = typeof service === 'function' ? new (service as unknown as new (...a: unknown[]) => Service)(...args) : service;
    return this._associatedHAPAccessory.addService(s);
  }

  removeService(service: Service): void {
    this._associatedHAPAccessory.removeService(service);
  }

  getService(name: string | ServiceCtor): Service | undefined {
    return this._associatedHAPAccessory.getService(name as never);
  }

  getServiceById(uuid: string | ServiceCtor, subType: string): Service | undefined {
    return this._associatedHAPAccessory.getServiceById(uuid as never, subType);
  }

  /** @deprecated */
  getServiceByUUIDAndSubType(uuid: string | ServiceCtor, subType: string): Service | undefined {
    return this.getServiceById(uuid, subType);
  }

  /** Cameras, TVs' remotes, …: Livynq does not run HomeKit controllers for bridged plugins. */
  configureController(_controller: unknown): void {}
  removeController(_controller: unknown): void {}
  /** @deprecated */
  configureCameraSource(_source: unknown): void {}

  static serialize(accessory: PlatformAccessory): SerializedPlatformAccessory {
    return {
      plugin: accessory._associatedPlugin ?? '',
      platform: accessory._associatedPlatform ?? '',
      context: accessory.context,
      ...hap.Accessory.serialize(accessory._associatedHAPAccessory),
    };
  }

  static deserialize(json: SerializedPlatformAccessory): PlatformAccessory {
    const hapAccessory = hap.Accessory.deserialize(json);
    const accessory = new PlatformAccessory(json.displayName, json.UUID, json.category);
    accessory._associatedHAPAccessory = hapAccessory;
    accessory._associatedPlugin = json.plugin;
    accessory._associatedPlatform = json.platform;
    accessory.context = (json.context ?? {}) as Record<string, unknown>;
    return accessory;
  }
}

// ---------------------------------------------------------------- API

export interface Registrar {
  registerPlatform(plugin: string, name: string, ctor: unknown): void;
  registerAccessory(plugin: string, name: string, ctor: unknown): void;
  registerPlatformAccessories(plugin: string, platform: string, accessories: PlatformAccessory[]): void;
  updatePlatformAccessories(accessories: PlatformAccessory[]): void;
  unregisterPlatformAccessories(plugin: string, platform: string, accessories: PlatformAccessory[]): void;
  publishExternalAccessories(plugin: string, accessories: PlatformAccessory[]): void;
}

export function versionGreaterOrEqual(version: string, current = SERVER_VERSION): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const [a, b] = [parse(current), parse(version)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/**
 * One `api` object per Homebridge plugin: register* calls without an explicit plugin identifier
 * are attributed to it, and its events can be emitted on their own.
 */
export class HomebridgeAPI extends EventEmitter {
  readonly version = API_VERSION;
  readonly serverVersion = SERVER_VERSION;
  readonly hap = hap;
  readonly hapLegacyTypes = (hap as unknown as { LegacyTypes?: unknown }).LegacyTypes;
  readonly platformAccessory = PlatformAccessory;
  readonly user: { configPath(): string; storagePath(): string; cachedAccessoryPath(): string; persistPath(): string };
  readonly #plugin: string;
  readonly #reg: Registrar;

  constructor(plugin: string, storage: string, registrar: Registrar) {
    super();
    this.setMaxListeners(0);
    this.#plugin = plugin;
    this.#reg = registrar;
    this.user = {
      configPath: () => join(storage, 'config.json'),
      storagePath: () => storage,
      cachedAccessoryPath: () => join(storage, 'accessories'),
      persistPath: () => join(storage, 'persist'),
    };
  }

  versionGreaterOrEqual(version: string): boolean {
    return versionGreaterOrEqual(version);
  }

  /** Homebridge 2.0: Matter bridging is Livynq's job, not the plugin's. */
  isMatterAvailable(): boolean {
    return false;
  }
  isMatterEnabled(): boolean {
    return false;
  }

  registerAccessory(a: string, b: unknown, c?: unknown): void {
    if (c === undefined) this.#reg.registerAccessory(this.#plugin, a, b);
    else this.#reg.registerAccessory(a, b as string, c);
  }

  registerPlatform(a: string, b: unknown, c?: unknown): void {
    if (c === undefined) this.#reg.registerPlatform(this.#plugin, a, b);
    else this.#reg.registerPlatform(a, b as string, c);
  }

  registerPlatformAccessories(plugin: string, platform: string, accessories: PlatformAccessory[]): void {
    this.#reg.registerPlatformAccessories(plugin, platform, accessories);
  }

  updatePlatformAccessories(accessories: PlatformAccessory[]): void {
    this.#reg.updatePlatformAccessories(accessories);
  }

  unregisterPlatformAccessories(plugin: string, platform: string, accessories: PlatformAccessory[]): void {
    this.#reg.unregisterPlatformAccessories(plugin, platform, accessories);
  }

  publishExternalAccessories(plugin: string, accessories: PlatformAccessory[]): void {
    this.#reg.publishExternalAccessories(plugin, accessories);
  }

  /** @deprecated */
  publishCameraAccessories(plugin: string, accessories: PlatformAccessory[]): void {
    this.publishExternalAccessories(plugin, accessories);
  }
}
