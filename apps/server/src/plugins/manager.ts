import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import semver from 'semver';
import { LivynqError, type Adapter, type Home } from '@livynq/core';
import { createPluginAdapter, pluginIdFor, resolvePlugin, type PluginEntry, type PluginRuntimeInfo } from '@livynq/plugin-host';
import type { PluginDefinition } from '@livynq/sdk';
import { readPluginEntries, updatePluginsInConfig } from '../config.ts';
import { InstallError, publicResolution, type InstalledRecord, type PackageSource, type Plan, type PluginInstaller, type ResolvedPlugin } from './installer.ts';

/**
 * Plugin lifecycle for the API, the web UI and the CLI: list, install, upgrade, uninstall,
 * enable, disable, reconfigure and restart — applied to the running hub (no restart) and
 * persisted in livynq.yaml.
 */

export interface OfficialPlugin {
  method: string;
  module: string;
  id: string;
  isolation: 'process' | 'in-process';
}

export type PluginSource = 'bundled' | 'builtin' | 'installed' | 'path';

export interface PluginRow {
  id: string;
  module?: string;
  path?: string;
  description?: string;
  source: PluginSource | 'missing';
  official: boolean;
  version: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  /** Has an entry in livynq.yaml (or runs anyway, e.g. the HA add-on bridge). */
  configured: boolean;
  enabled: boolean;
  status: string;
  isolation: 'process' | 'in-process';
  config: Record<string, unknown>;
  lastError: string | null;
  pid?: number | null;
  restarts?: number;
  devices?: number;
  startedAt?: number | null;
  actions: { name: string; description: string }[];
  installed?: Pick<InstalledRecord, 'source' | 'spec' | 'installedAt' | 'packages'>;
  canUninstall: boolean;
  canUpgrade: boolean;
}

export interface PluginManagerOptions {
  installer: PluginInstaller;
  official: OfficialPlugin[];
  hubVersion: string;
  configFile?: string;
  initialEntries?: PluginEntry[];
  bundled?: Record<string, PluginDefinition>;
  resolveBuiltin?: (specifier: string) => string;
}

type RuntimeAdapter = Adapter & { info?: () => PluginRuntimeInfo; restart?: () => Promise<void> };

export class PluginManager {
  readonly installer: PluginInstaller;
  readonly #home: Home;
  readonly #o: PluginManagerOptions;
  /** Entries when there is no livynq.yaml (tests, embedded use). */
  #memory: PluginEntry[];
  /** Serialises lifecycle operations. */
  #busy: Promise<unknown> = Promise.resolve();

  constructor(home: Home, options: PluginManagerOptions) {
    this.#home = home;
    this.#o = options;
    this.installer = options.installer;
    this.#memory = [...(options.initialEntries ?? [])];
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(fn, fn);
    this.#busy = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- entries

  entries(): PluginEntry[] {
    return this.#o.configFile ? readPluginEntries(this.#o.configFile) : [...this.#memory];
  }

  #matches(a: PluginEntry, b: PluginEntry): boolean {
    return (a.module ?? a.path) === (b.module ?? b.path);
  }

  #save(entry: PluginEntry): void {
    if (this.#o.configFile) updatePluginsInConfig(this.#o.configFile, { add: entry });
    else this.#memory = [...this.#memory.filter((e) => !this.#matches(e, entry)), entry];
  }

  #drop(entry: PluginEntry): void {
    if (this.#o.configFile) updatePluginsInConfig(this.#o.configFile, { remove: (e) => this.#matches(e, entry) });
    else this.#memory = this.#memory.filter((e) => !this.#matches(e, entry));
  }

  /** The entry for an id: configured ones first, then an official plugin that is not configured yet. */
  #find(id: string): { entry: PluginEntry; configured: boolean; official?: OfficialPlugin } | undefined {
    const configured = this.entries().find((e) => pluginIdFor(e) === id);
    const official = this.#o.official.find((o) => o.id === id || (configured?.module && o.module === configured.module));
    if (configured) return { entry: configured, configured: true, ...(official ? { official } : {}) };
    if (official) return { entry: { module: official.module, isolation: official.isolation }, configured: false, official };
    return undefined;
  }

  #require(id: string) {
    const found = this.#find(id);
    if (!found) throw new LivynqError('NOT_FOUND', `No plugin "${id}"`);
    return found;
  }

  // ---------------------------------------------------------------- facts

  #configDir(): string {
    return this.#o.configFile ? dirname(this.#o.configFile) : this.#home.dataDir;
  }

  #source(entry: PluginEntry): PluginRow['source'] {
    if (entry.path) return existsSync(isAbsolute(entry.path) ? entry.path : resolve(this.#configDir(), entry.path)) ? 'path' : 'missing';
    if (!entry.module) return 'missing';
    if (existsSync(join(this.installer.packageDir(entry.module), 'package.json'))) return 'installed';
    if (this.#o.bundled?.[entry.module]) return 'bundled';
    try {
      this.#o.resolveBuiltin?.(entry.module);
      return this.#o.resolveBuiltin ? 'builtin' : 'missing';
    } catch {
      return 'missing';
    }
  }

  #packageJson(entry: PluginEntry, source: PluginRow['source']): { version?: string; description?: string } | undefined {
    const read = (file: string) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string; description?: string };
      } catch {
        return undefined;
      }
    };
    if (source === 'installed' && entry.module) return read(join(this.installer.packageDir(entry.module), 'package.json'));
    if (source === 'path' && entry.path) {
      const p = isAbsolute(entry.path) ? entry.path : resolve(this.#configDir(), entry.path);
      return read(join(existsSync(join(p, 'package.json')) ? p : dirname(p), 'package.json'));
    }
    if (source === 'builtin' && entry.module && this.#o.resolveBuiltin) {
      // Walk up from the resolved entry file to the package's own package.json.
      let dir = dirname(this.#o.resolveBuiltin(entry.module));
      for (let i = 0; i < 6; i++, dir = dirname(dir)) {
        const pkg = read(join(dir, 'package.json'));
        if (pkg?.name === entry.module) return pkg;
      }
    }
    if (source === 'bundled') return { version: this.#o.hubVersion };
    return undefined;
  }

  #row(id: string, entry: PluginEntry, configured: boolean, official: boolean): PluginRow {
    const adapter = this.#home.adapter<RuntimeAdapter>(id);
    const info = adapter?.info?.();
    const source = this.#source(entry);
    const pkg = this.#packageJson(entry, source);
    const record = entry.module ? this.installer.installed()[entry.module] : undefined;
    const enabled = Boolean(adapter) || (configured && entry.enabled !== false);
    return {
      id,
      ...(entry.module ? { module: entry.module } : {}),
      ...(entry.path ? { path: entry.path } : {}),
      ...(pkg?.description ? { description: pkg.description } : {}),
      source,
      official,
      version: pkg?.version ?? null,
      configured: configured || Boolean(adapter),
      enabled,
      status: adapter ? (info?.status ?? 'running') : configured && entry.enabled !== false ? (source === 'missing' ? 'missing' : 'stopped') : 'off',
      isolation: (info?.isolation ?? (source === 'bundled' ? 'in-process' : (entry.isolation ?? 'process'))) as 'process' | 'in-process',
      config: entry.config ?? {},
      lastError: info?.lastError ?? (source === 'missing' && configured ? 'not installed' : null),
      ...(info && 'pid' in info ? { pid: info.pid, restarts: info.restarts, devices: info.devices, startedAt: info.startedAt } : {}),
      actions: adapter ? this.#home.actions(id) : [],
      ...(record && source === 'installed' ? { installed: { source: record.source, spec: record.spec, installedAt: record.installedAt, packages: record.packages } } : {}),
      canUninstall: source === 'installed',
      canUpgrade: source === 'installed' && record?.source !== 'file',
    };
  }

  /** Configured plugins plus official ones that are not set up yet. */
  async list(options: { checkUpdates?: boolean; force?: boolean } = {}): Promise<PluginRow[]> {
    const rows: PluginRow[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries()) {
      const id = pluginIdFor(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(this.#row(id, entry, true, this.#o.official.some((o) => o.module === entry.module)));
    }
    for (const o of this.#o.official) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      rows.push(this.#row(o.id, { module: o.module, isolation: o.isolation }, false, true));
    }
    if (options.checkUpdates) {
      await Promise.all(
        rows
          .filter((r) => r.canUpgrade && r.module)
          .map(async (r) => {
            r.latest = await this.installer.latest(r.module!, options.force);
            r.updateAvailable = Boolean(r.latest && r.version && r.latest !== r.version && isNewer(r.latest, r.version));
          }),
      );
    }
    return rows;
  }

  row(id: string): PluginRow {
    const found = this.#require(id);
    return this.#row(id, found.entry, found.configured, Boolean(found.official));
  }

  // ---------------------------------------------------------------- lifecycle

  async #start(entry: PluginEntry): Promise<string> {
    const resolved = resolvePlugin(entry, { dataDir: this.#home.dataDir, configDir: this.#configDir(), resolveBuiltin: this.#o.resolveBuiltin, bundled: this.#o.bundled });
    if (this.#home.adapters().includes(resolved.id)) await this.#home.removeAdapter(resolved.id);
    await this.#home.addAdapter(await createPluginAdapter(resolved));
    await settle(this.#home, resolved.id);
    return resolved.id;
  }

  async #stop(id: string): Promise<void> {
    if (this.#home.adapters().includes(id)) await this.#home.removeAdapter(id);
  }

  /** Enables (configuring it if needed) and starts a plugin. */
  enable(id: string, config?: Record<string, unknown>): Promise<PluginRow> {
    return this.#serial(async () => {
      const { entry, official } = this.#require(id);
      if (this.#home.adapters().includes(id) && config === undefined) return this.row(id);
      const next: PluginEntry = { ...entry, ...(official && !entry.isolation ? { isolation: official.isolation } : {}) };
      delete next.enabled;
      if (config !== undefined) {
        if (Object.keys(config).length) next.config = config;
        else delete next.config;
      }
      await this.#start(next);
      this.#save(next);
      return this.row(id);
    });
  }

  /** Stops a plugin and keeps it configured as disabled. */
  disable(id: string): Promise<PluginRow> {
    return this.#serial(async () => {
      const { entry, configured } = this.#require(id);
      await this.#stop(id);
      if (configured) this.#save({ ...entry, enabled: false });
      return this.row(id);
    });
  }

  /** New config: saved, and the plugin restarts with it when it runs. */
  configure(id: string, config: Record<string, unknown>): Promise<PluginRow> {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new LivynqError('INVALID_PARAMS', 'config must be an object');
    return this.#serial(async () => {
      const { entry, official, configured } = this.#require(id);
      const next: PluginEntry = { ...entry, ...(official && !entry.isolation ? { isolation: official.isolation } : {}) };
      if (Object.keys(config).length) next.config = config;
      else delete next.config;
      // Not set up yet: just remember the config (disabled) until it is switched on.
      if (!configured) next.enabled = false;
      else if (this.#home.adapters().includes(id) || entry.enabled !== false) {
        delete next.enabled;
        await this.#start(next);
      }
      this.#save(next);
      return this.row(id);
    });
  }

  restart(id: string): Promise<PluginRow> {
    return this.#serial(async () => {
      const adapter = this.#home.adapter<RuntimeAdapter>(id);
      if (adapter?.restart) await adapter.restart();
      else {
        const { entry } = this.#require(id);
        await this.#start({ ...entry, enabled: true });
      }
      await settle(this.#home, id);
      return this.row(id);
    });
  }

  /** Stops and forgets a plugin; `uninstall` also deletes files installed from npm / a file. */
  remove(id: string, options: { uninstall?: boolean } = {}): Promise<{ removed: string; uninstalled: boolean }> {
    return this.#serial(async () => {
      const found = this.#find(id);
      if (!found && !this.#home.adapters().includes(id)) throw new LivynqError('NOT_FOUND', `No plugin "${id}"`);
      await this.#stop(id);
      let uninstalled = false;
      if (found) {
        this.#drop(found.entry);
        if (options.uninstall && found.entry.module && this.#source(found.entry) === 'installed') uninstalled = this.installer.uninstall(found.entry.module);
      }
      return { removed: id, uninstalled };
    });
  }

  // ---------------------------------------------------------------- install

  /** Dry run: what would be installed, plus conflicts with what is there. */
  async preview(source: PackageSource): Promise<ResolvedPlugin & { id: string; installedVersion: string | null; conflict?: string; _plan: Plan }> {
    const resolved = await this.#resolve(source);
    const id = pluginIdFor({ module: resolved.root.name });
    const other = this.entries().find((e) => pluginIdFor(e) === id && e.module !== resolved.root.name);
    const installedVersion = this.installer.installedVersion(resolved.root.name);
    return {
      ...resolved,
      id,
      installedVersion,
      ...(other ? { conflict: `the plugin id "${id}" is already used by ${other.module ?? other.path}` } : {}),
    };
  }

  async #resolve(source: PackageSource): Promise<ResolvedPlugin & { _plan: Plan }> {
    try {
      return await this.installer.resolve(source);
    } catch (err) {
      if (err instanceof InstallError) throw new LivynqError('INVALID_PARAMS', err.message);
      throw err;
    }
  }

  /** Installs (or reinstalls) and starts a plugin. */
  install(source: PackageSource, options: { enable?: boolean; config?: Record<string, unknown>; isolation?: 'process' | 'in-process' } = {}): Promise<PluginRow & { warnings: string[] }> {
    return this.#serial(async () => {
      const plan = await this.preview(source);
      if (plan.conflict) throw new LivynqError('CONFLICT', `Cannot install ${plan.root.name}: ${plan.conflict}`);
      const id = plan.id;
      const existing = this.entries().find((e) => e.module === plan.root.name);
      const wasRunning = this.#home.adapters().includes(id);
      await this.#stop(id);
      try {
        await this.installer.install(plan);
      } catch (err) {
        if (wasRunning && existing) await this.#start(existing).catch(() => {});
        throw err instanceof InstallError ? new LivynqError('INVALID_PARAMS', err.message) : err;
      }
      const entry: PluginEntry = {
        ...(existing ?? { module: plan.root.name }),
        ...(options.isolation ? { isolation: options.isolation } : {}),
        ...(options.config && Object.keys(options.config).length ? { config: options.config } : {}),
      };
      if (options.enable === false) entry.enabled = false;
      else delete entry.enabled;
      this.#save(entry);
      if (entry.enabled !== false) {
        try {
          await this.#start(entry);
        } catch (err) {
          return { ...this.row(id), lastError: (err as Error).message, warnings: plan.warnings };
        }
      }
      return { ...this.row(id), warnings: plan.warnings };
    });
  }

  /** Installs the newest registry version of an installed plugin and restarts it. */
  async upgrade(id: string): Promise<PluginRow & { upgraded: boolean; from: string | null; warnings: string[] }> {
    const { entry } = this.#require(id);
    if (!entry.module || this.#source(entry) !== 'installed') throw new LivynqError('NOT_SUPPORTED', `${id} ships with Livynq; it is upgraded together with Livynq`);
    const record = this.installer.installed()[entry.module];
    if (record?.source === 'file') throw new LivynqError('NOT_SUPPORTED', `${id} was installed from a file; install the new file instead`);
    const from = this.installer.installedVersion(entry.module);
    const latest = await this.installer.latest(entry.module, true);
    if (!latest) throw new LivynqError('NOT_FOUND', `Cannot find ${entry.module} on ${this.installer.registry}`);
    if (from && !isNewer(latest, from)) return { ...this.row(id), upgraded: false, from, warnings: [] };
    const row = await this.install({ spec: `${entry.module}@${latest}` });
    return { ...row, upgraded: true, from };
  }

  // ---------------------------------------------------------------- official (Add device wizard)

  enableOfficial(module: string, config?: Record<string, unknown>): Promise<PluginRow> {
    const official = this.#o.official.find((o) => o.module === module);
    if (!official) throw new LivynqError('INVALID_PARAMS', `Only official plugins can be enabled here (${this.#o.official.map((o) => o.module).join(', ')}); install others under Settings → Plugins`);
    if (this.#home.adapters().includes(official.id)) throw new LivynqError('CONFLICT', `${official.id} is already enabled`);
    return this.enable(official.id, config ?? {});
  }
}

export function isNewer(a: string, b: string): boolean {
  return semver.valid(a) !== null && semver.valid(b) !== null && semver.gt(a, b);
}

/** Waits briefly so a plugin that fails on start (wrong serial port…) is reported as such, not as success. */
export async function settle(home: Home, id: string): Promise<{ status: string; lastError: string | null }> {
  const info = () => home.adapter<RuntimeAdapter>(id)?.info?.();
  for (let i = 0; i < 30; i++) {
    const s = info();
    if (!s || s.status === 'running' || s.status === 'crashed' || s.status === 'disabled') return { status: s?.status ?? 'running', lastError: s?.lastError ?? null };
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = info();
  return { status: s?.status ?? 'running', lastError: s?.lastError ?? null };
}

export { publicResolution };
