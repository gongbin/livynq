import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Accessory, Service } from 'hap-nodejs';
import { HomebridgeAPI, PlatformAccessory, createLogger, type Logging, type Registrar, type SerializedPlatformAccessory, type Sink } from './api.ts';
import { hap } from './hap.ts';

/**
 * Runs Homebridge plugins: loads their modules, constructs the platforms and accessories named
 * in the Homebridge-format config, restores cached platform accessories (configureAccessory)
 * and emits didFinishLaunching / shutdown — the same sequence Homebridge follows.
 */

export interface Block {
  platform?: string;
  accessory?: string;
  name?: string;
  [key: string]: unknown;
}

export interface HomebridgeConfig {
  platforms: Block[];
  accessories: Block[];
}

export interface Bridged {
  uuid: string;
  accessory: Accessory;
  plugin: string;
  platform?: string;
  source: 'platform' | 'static' | 'external';
}

export interface RuntimeEvents {
  add(b: Bridged): void;
  remove(uuid: string): void;
  changed(b: Bridged): void;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  dir: string;
  loaded: boolean;
  error?: string;
  platforms: string[];
  accessories: string[];
  /** config.schema.json: the block type it configures */
  alias?: string;
  type?: 'platform' | 'accessory';
}

export interface Issue {
  plugin?: string;
  block?: string;
  message: string;
}

interface TypeEntry {
  plugin: string;
  name: string;
  ctor: new (...args: unknown[]) => Record<string, unknown>;
}

interface PlatformInstance {
  plugin: string;
  name: string;
  block: Block;
  instance: Record<string, unknown>;
}

/** The module a package.json points at (exports "." → import/require/default, else main). */
export function entryOf(dir: string, pkg: { main?: string; exports?: unknown; module?: string }): string {
  let rel: string | undefined;
  const exp = pkg.exports as unknown;
  const pickCond = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['node', 'import', 'require', 'default']) {
        const hit = pickCond(o[k]);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  if (typeof exp === 'string') rel = exp;
  else if (exp && typeof exp === 'object') rel = pickCond((exp as Record<string, unknown>)['.'] ?? exp);
  rel ??= pkg.main ?? 'index.js';
  const base = join(dir, rel);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, join(base, 'index.js')]) {
    if (existsSync(candidate) && !isDir(candidate)) return candidate;
  }
  throw new Error(`cannot find the entry point (${rel})`);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Packages under node_modules that declare themselves Homebridge plugins (keyword "homebridge-plugin"). */
export function findPluginDirs(nodeModules: string): string[] {
  const out: string[] = [];
  if (!existsSync(nodeModules)) return out;
  const consider = (dir: string) => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { keywords?: string[]; livynqShim?: boolean };
      if (!pkg.livynqShim && pkg.keywords?.includes('homebridge-plugin')) out.push(dir);
    } catch {
      // not a package
    }
  };
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) for (const sub of readdirSync(join(nodeModules, entry))) consider(join(nodeModules, entry, sub));
    else consider(join(nodeModules, entry));
  }
  return out.sort();
}

export function pluginSchema(dir: string): { alias?: string; type?: 'platform' | 'accessory' } {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'config.schema.json'), 'utf8')) as { pluginAlias?: string; pluginType?: string };
    return { ...(s.pluginAlias ? { alias: s.pluginAlias } : {}), ...(s.pluginType === 'platform' || s.pluginType === 'accessory' ? { type: s.pluginType } : {}) };
  } catch {
    return {};
  }
}

export class HomebridgeRuntime implements Registrar {
  readonly plugins = new Map<string, LoadedPlugin>();
  readonly issues: Issue[] = [];
  readonly #apis = new Map<string, HomebridgeAPI>();
  readonly #platformTypes = new Map<string, TypeEntry>();
  readonly #accessoryTypes = new Map<string, TypeEntry>();
  readonly #instances: PlatformInstance[] = [];
  /** Dynamic platform accessories, restored from the cache or registered since. */
  readonly #cached = new Map<string, PlatformAccessory>();
  readonly #bridged = new Map<string, Bridged>();
  readonly #storage: string;
  readonly #sink: Sink;
  readonly #events: RuntimeEvents;
  #launched = false;

  constructor(options: { storage: string; sink: Sink; events: RuntimeEvents }) {
    this.#storage = options.storage;
    this.#sink = options.sink;
    this.#events = options.events;
  }

  get cacheFile(): string {
    return join(this.#storage, 'accessories', 'cachedAccessories');
  }

  /** Runs a plugin callback; a failing plugin is reported, never fatal for the others. */
  #guard<T>(label: string, plugin: string, fn: () => T): T | undefined {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((err: unknown) => this.#issue(plugin, label, err));
      return r;
    } catch (err) {
      this.#issue(plugin, label, err);
      return undefined;
    }
  }

  #issue(plugin: string | undefined, block: string | undefined, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.issues.push({ ...(plugin ? { plugin } : {}), ...(block ? { block } : {}), message });
    this.#sink.error(`[${plugin ?? 'homebridge'}] ${block ? `${block}: ` : ''}${err instanceof Error ? (err.stack ?? message) : message}`);
  }

  // ---------------------------------------------------------------- loading

  async loadPlugin(dir: string): Promise<LoadedPlugin> {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; main?: string; exports?: unknown };
    const info: LoadedPlugin = { name: pkg.name, version: pkg.version, dir, loaded: false, platforms: [], accessories: [], ...pluginSchema(dir) };
    this.plugins.set(pkg.name, info);
    try {
      const entry = entryOf(dir, pkg);
      const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
      let init: unknown = mod.default ?? mod;
      if (typeof init !== 'function' && init && typeof (init as { default?: unknown }).default === 'function') init = (init as { default: unknown }).default;
      if (typeof init !== 'function') throw new Error('the module does not export an initializer function');
      const api = new HomebridgeAPI(pkg.name, this.#storage, this);
      this.#apis.set(pkg.name, api);
      await (init as (api: HomebridgeAPI) => unknown)(api);
      info.loaded = true;
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err);
      this.#issue(pkg.name, undefined, err);
    }
    return info;
  }

  registerPlatform(plugin: string, name: string, ctor: unknown): void {
    this.#platformTypes.set(`${plugin}.${name}`, { plugin, name, ctor: ctor as TypeEntry['ctor'] });
    this.plugins.get(plugin)?.platforms.push(name);
  }

  registerAccessory(plugin: string, name: string, ctor: unknown): void {
    this.#accessoryTypes.set(`${plugin}.${name}`, { plugin, name, ctor: ctor as TypeEntry['ctor'] });
    this.plugins.get(plugin)?.accessories.push(name);
  }

  /** "Dummy" or "homebridge-dummy.Dummy" → the registered type. */
  #find(types: Map<string, TypeEntry>, id: string): TypeEntry | undefined {
    return types.get(id) ?? [...types.values()].find((t) => t.name === id);
  }

  // ---------------------------------------------------------------- start / stop

  start(config: HomebridgeConfig): void {
    this.#loadCache();
    for (const block of config.platforms) this.#startPlatform(block);
    for (const block of config.accessories) this.#startAccessory(block);
    // Cached accessories go back to their platform before didFinishLaunching, as in Homebridge.
    for (const acc of this.#cached.values()) {
      const instance = this.#instances.find((p) => p.plugin === acc._associatedPlugin && p.name === acc._associatedPlatform);
      if (!instance || typeof instance.instance.configureAccessory !== 'function') continue;
      this.#guard('configureAccessory', instance.plugin, () => (instance.instance.configureAccessory as (a: PlatformAccessory) => void).call(instance.instance, acc));
      this.#bridge({ uuid: acc.UUID, accessory: acc._associatedHAPAccessory, plugin: instance.plugin, platform: instance.name, source: 'platform' });
    }
    this.#launched = true;
    for (const [plugin, api] of this.#apis) this.#guard('didFinishLaunching', plugin, () => api.emit('didFinishLaunching'));
  }

  #startPlatform(block: Block): void {
    const id = String(block.platform ?? '');
    const type = this.#find(this.#platformTypes, id);
    const label = `platform ${id}${block.name ? ` (${block.name})` : ''}`;
    if (!type) {
      this.issues.push({ block: label, message: `no installed plugin provides the platform "${id}"` });
      return;
    }
    const log = this.#logger(type.plugin, String(block.name ?? type.name));
    const { _bridge: _child, ...cfg } = block;
    const instance = this.#guard(label, type.plugin, () => new type.ctor(log, cfg, this.#apis.get(type.plugin)));
    if (!instance) return;
    this.#instances.push({ plugin: type.plugin, name: type.name, block, instance });
    // Static platforms hand over their accessories through a callback.
    if (typeof instance.accessories === 'function') {
      this.#guard(`${label} accessories`, type.plugin, () =>
        (instance.accessories as (cb: (list: Record<string, unknown>[]) => void) => void).call(instance, (list) => {
          for (const a of list ?? []) {
            const acc = this.#guard(`${label} accessory`, type.plugin, () => this.#wrapStatic(type.plugin, type.name, a, { name: a.name as string, uuid_base: a.uuid_base }));
            if (acc) this.#bridge({ uuid: acc.UUID, accessory: acc, plugin: type.plugin, platform: type.name, source: 'static' });
          }
        }),
      );
    }
  }

  #startAccessory(block: Block): void {
    const id = String(block.accessory ?? '');
    const type = this.#find(this.#accessoryTypes, id);
    const label = `accessory ${id}${block.name ? ` (${block.name})` : ''}`;
    if (!type) {
      this.issues.push({ block: label, message: `no installed plugin provides the accessory "${id}"` });
      return;
    }
    const log = this.#logger(type.plugin, String(block.name ?? type.name));
    const { _bridge: _child, ...cfg } = block;
    const instance = this.#guard(label, type.plugin, () => new type.ctor(log, cfg, this.#apis.get(type.plugin)));
    if (!instance) return;
    const acc = this.#guard(label, type.plugin, () => this.#wrapStatic(type.plugin, type.name, instance, block));
    if (acc) this.#bridge({ uuid: acc.UUID, accessory: acc, plugin: type.plugin, source: 'static' });
  }

  /** An AccessoryPlugin (getServices) becomes a HAP accessory, as Homebridge's bridge does it. */
  #wrapStatic(plugin: string, typeName: string, instance: Record<string, unknown>, block: { name?: unknown; uuid_base?: unknown }): Accessory {
    const name = String(block.name ?? instance.name ?? typeName);
    const uuid = hap.uuid.generate(`${plugin}.${typeName}:${String(block.uuid_base ?? name)}`);
    const acc = new hap.Accessory(name, uuid);
    const services = ((instance.getServices as () => Service[]).call(instance) ?? []) as Service[];
    for (const s of services) {
      if (s.UUID === hap.Service.AccessoryInformation.UUID) acc.getService(hap.Service.AccessoryInformation)?.replaceCharacteristicsFromService(s);
      else acc.addService(s);
    }
    if (typeof instance.identify === 'function') acc.on('identify' as never, ((_p: boolean, cb: () => void) => this.#guard('identify', plugin, () => (instance.identify as (cb: () => void) => void).call(instance, () => cb()))) as never);
    return acc;
  }

  #logger(plugin: string, prefix: string): Logging {
    return createLogger(this.#sink, prefix || plugin);
  }

  async stop(): Promise<void> {
    for (const [plugin, api] of this.#apis) this.#guard('shutdown', plugin, () => api.emit('shutdown'));
    this.saveCache();
  }

  // ---------------------------------------------------------------- dynamic accessories (Registrar)

  #bridge(b: Bridged): void {
    if (this.#bridged.has(b.uuid)) {
      this.#sink.warn(`[${b.plugin}] accessory ${b.uuid} is already bridged; ignoring the duplicate`);
      return;
    }
    this.#bridged.set(b.uuid, b);
    this.#events.add(b);
  }

  registerPlatformAccessories(plugin: string, platform: string, accessories: PlatformAccessory[]): void {
    for (const acc of accessories) {
      acc._associatedPlugin = plugin;
      acc._associatedPlatform = platform;
      this.#cached.set(acc.UUID, acc);
      this.#bridge({ uuid: acc.UUID, accessory: acc._associatedHAPAccessory, plugin, platform, source: 'platform' });
    }
    this.saveCache();
  }

  updatePlatformAccessories(accessories: PlatformAccessory[]): void {
    for (const acc of accessories) {
      const b = this.#bridged.get(acc.UUID);
      if (b) {
        b.accessory = acc._associatedHAPAccessory;
        this.#events.changed(b);
      }
    }
    this.saveCache();
  }

  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: PlatformAccessory[]): void {
    for (const acc of accessories) {
      this.#cached.delete(acc.UUID);
      if (this.#bridged.delete(acc.UUID)) this.#events.remove(acc.UUID);
    }
    this.saveCache();
  }

  publishExternalAccessories(plugin: string, accessories: PlatformAccessory[]): void {
    for (const acc of accessories) this.#bridge({ uuid: acc.UUID, accessory: acc._associatedHAPAccessory, plugin, platform: acc._associatedPlatform, source: 'external' });
  }

  /** Cached accessories whose plugin / platform is not running (kept, not bridged). */
  orphans(): { uuid: string; name: string; plugin: string; platform: string }[] {
    return [...this.#cached.values()]
      .filter((a) => !this.#bridged.has(a.UUID))
      .map((a) => ({ uuid: a.UUID, name: a.displayName, plugin: a._associatedPlugin ?? '', platform: a._associatedPlatform ?? '' }));
  }

  get launched(): boolean {
    return this.#launched;
  }

  // ---------------------------------------------------------------- cache

  #loadCache(): void {
    let list: SerializedPlatformAccessory[] = [];
    try {
      list = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as SerializedPlatformAccessory[];
    } catch {
      return;
    }
    for (const json of list) {
      try {
        const acc = PlatformAccessory.deserialize(json);
        this.#cached.set(acc.UUID, acc);
      } catch (err) {
        this.#sink.warn(`skipping a cached accessory that cannot be restored (${(err as Error).message})`);
      }
    }
  }

  saveCache(): void {
    const list: SerializedPlatformAccessory[] = [];
    for (const acc of this.#cached.values()) {
      try {
        list.push(PlatformAccessory.serialize(acc));
      } catch (err) {
        this.#sink.warn(`[${acc._associatedPlugin}] cannot cache ${acc.displayName}: ${(err as Error).message}`);
      }
    }
    mkdirSync(join(this.#storage, 'accessories'), { recursive: true });
    const tmp = `${this.cacheFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
    renameSync(tmp, this.cacheFile);
  }
}
