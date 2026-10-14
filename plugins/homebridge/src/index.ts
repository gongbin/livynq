import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { InstallError, PackageInstaller, parseSpec, publicResolution } from '@livynq/installer';
import { defineAdapter, type PluginContext } from '@livynq/sdk';
import { SERVER_VERSION, type SerializedPlatformAccessory } from './api.ts';
import { DeviceBridge } from './bridge.ts';
import { expandHome, mergeCachedAccessories, planImport } from './importer.ts';
import { HomebridgeRuntime, findPluginDirs, type Block, type HomebridgeConfig } from './runtime.ts';
import { homebridgeShims, provideHomebridge } from './shims.ts';

/**
 * Homebridge compatibility: runs Homebridge plugins inside Livynq and turns their accessories
 * into Livynq devices (which Livynq then exposes to Apple Home, Matter, automations and agents).
 *
 *   plugins:
 *     - module: "@livynq/plugin-homebridge"
 *       config:
 *         pollSeconds: 30          # how often plugins' get handlers are read
 *         platforms: []           # optional, Homebridge format; blocks set in the UI live in the plugin data dir
 *         accessories: []
 *
 * Homebridge plugins are installed into the plugin data directory with Livynq's own installer
 * (no npm, no install scripts). Changes to plugins or their config apply after restarting this
 * plugin, as in Homebridge.
 */

export { SERVER_VERSION } from './api.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates Homebridge-format platform / accessory arrays. */
export function validateConfig(value: unknown): HomebridgeConfig {
  if (!isObj(value)) throw new Error('config must be an object with "platforms" and/or "accessories" arrays');
  const out: HomebridgeConfig = { platforms: [], accessories: [] };
  for (const key of ['platforms', 'accessories'] as const) {
    const list = value[key] ?? [];
    if (!Array.isArray(list)) throw new Error(`"${key}" must be an array`);
    list.forEach((b, i) => {
      if (!isObj(b)) throw new Error(`${key}[${i}] must be an object`);
      const type = key === 'platforms' ? b.platform : b.accessory;
      if (typeof type !== 'string' || !type.trim()) throw new Error(`${key}[${i}] needs a "${key === 'platforms' ? 'platform' : 'accessory'}" name`);
      if (key === 'accessories' && (typeof b.name !== 'string' || !b.name.trim())) throw new Error(`accessories[${i}] needs a "name"`);
      out[key].push(b as Block);
    });
  }
  return out;
}

const isHomebridgePlugin = (root: { name: string; keywords?: string[] }) => Boolean(root.keywords?.includes('homebridge-plugin') || /^(@[^/]+\/)?homebridge-/.test(root.name));

export default defineAdapter({
  async setup(ctx: PluginContext) {
    const storage = ctx.dataDir;
    mkdirSync(storage, { recursive: true });
    provideHomebridge();
    const installer = new PackageInstaller({
      dir: storage,
      ...(typeof ctx.config.registry === 'string' ? { registry: ctx.config.registry } : {}),
      host: {
        provided: homebridgeShims(),
        compat: {
          name: 'homebridge',
          engine: 'homebridge',
          version: SERVER_VERSION,
          missing: (root) => (isHomebridgePlugin(root) ? undefined : `${root.name} does not look like a Homebridge plugin (no "homebridge-plugin" keyword)`),
          incompatible: (root, ranges) => `${root.name} asks for Homebridge ${ranges.join(' / ')}; Livynq provides the Homebridge ${SERVER_VERSION} plugin API`,
        },
      },
    });
    const nodeModules = join(storage, 'node_modules');
    // Plugins copied in by hand or installed by an older Livynq get fresh shims too.
    installer.refreshShims(findPluginDirs(nodeModules).map((d) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name as string));

    const configFile = join(storage, 'config.json');
    const readStored = (): HomebridgeConfig => {
      try {
        return validateConfig(JSON.parse(readFileSync(configFile, 'utf8')));
      } catch {
        return { platforms: [], accessories: [] };
      }
    };
    const writeStored = (c: HomebridgeConfig) => writeFileSync(configFile, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
    if (!existsSync(configFile)) writeStored({ platforms: [], accessories: [] });
    const fromYaml = validateConfig({ platforms: ctx.config.platforms ?? [], accessories: ctx.config.accessories ?? [] });
    const stored = readStored();
    const active: HomebridgeConfig = { platforms: [...fromYaml.platforms, ...stored.platforms], accessories: [...fromYaml.accessories, ...stored.accessories] };

    const pollMs = Math.max(5, Number(ctx.config.pollSeconds ?? 30)) * 1000;
    const bridge = new DeviceBridge(ctx, { pollMs });
    const sink = {
      info: (m: string) => ctx.log.info(m),
      warn: (m: string) => ctx.log.warn(m),
      error: (m: string) => ctx.log.error(m),
      debug: (m: string) => ctx.log.debug(m),
    };
    const runtime = new HomebridgeRuntime({
      storage,
      sink,
      events: { add: (b) => bridge.add(b), remove: (uuid) => void bridge.remove(uuid), changed: (b) => bridge.changed(b) },
    });

    const extraPaths = (Array.isArray(ctx.config.pluginPaths) ? ctx.config.pluginPaths : []).map((p) => (isAbsolute(String(p)) ? String(p) : resolve(String(p))));
    for (const dir of [...findPluginDirs(nodeModules), ...extraPaths]) await runtime.loadPlugin(dir);
    runtime.start(active);
    ctx.log.info(`Homebridge layer: ${runtime.plugins.size} plugin(s), ${active.platforms.length} platform(s), ${active.accessories.length} accessory block(s)`);

    const restartNote = { restartRequired: true, note: 'Restart the Homebridge plugin to apply (Plugins → homebridge → Restart)' };

    ctx.actions.register('preview', 'What installing a Homebridge plugin would download: { name }', async (p) => {
      const name = String(p.name ?? '').trim();
      parseSpec(name);
      return publicResolution(await installer.resolve({ spec: name }));
    });
    ctx.actions.register('install', 'Install a Homebridge plugin from npm: { name } (e.g. homebridge-dummy or homebridge-dummy@1.2.0)', async (p) => {
      const name = String(p.name ?? '').trim();
      const resolved = await installer.resolve({ spec: name });
      const record = await installer.install(resolved);
      return { installed: record.name, version: record.version, packages: record.packages, warnings: resolved.warnings, ...restartNote };
    });
    ctx.actions.register('uninstall', 'Remove a Homebridge plugin: { name }', (p) => {
      const name = String(p.name ?? '').trim();
      if (!installer.uninstall(name)) throw new InstallError(`${name} is not installed`);
      return { removed: name, ...restartNote };
    });
    ctx.actions.register('plugins', 'Installed Homebridge plugins and what they provide', () => {
      const records = installer.installed();
      const dirs = findPluginDirs(nodeModules);
      const names = new Set([...Object.keys(records), ...dirs.map((d) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name as string)]);
      return [...names].sort().map((name) => {
        const loaded = runtime.plugins.get(name);
        return {
          name,
          version: installer.installedVersion(name) ?? loaded?.version ?? null,
          loaded: Boolean(loaded?.loaded),
          ...(loaded?.error ? { error: loaded.error } : {}),
          platforms: loaded?.platforms ?? [],
          accessories: loaded?.accessories ?? [],
          ...(loaded?.alias ? { alias: loaded.alias, type: loaded.type } : {}),
          pendingRestart: !loaded,
        };
      });
    });
    ctx.actions.register('schema', 'A plugin\'s config.schema.json (for config forms): { name }', (p) => {
      const name = String(p.name ?? '');
      parseSpec(name);
      const file = join(installer.packageDir(name), 'config.schema.json');
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    });
    ctx.actions.register('accessories', 'Bridged accessories: mapped to Livynq devices or unsupported, plus config problems', () => ({
      accessories: bridge.report(),
      orphans: runtime.orphans(),
      issues: runtime.issues,
    }));
    ctx.actions.register('config', 'Homebridge-format config: {} to read, { platforms, accessories } to replace', (p) => {
      if (p.platforms === undefined && p.accessories === undefined) return { ...readStored(), fromLivynqConfig: fromYaml };
      const current = readStored();
      const next = validateConfig({ platforms: p.platforms ?? current.platforms, accessories: p.accessories ?? current.accessories });
      writeStored(next);
      return { ...next, ...restartNote };
    });
    ctx.actions.register('import', 'Plan a move from an existing Homebridge: { path } (e.g. ~/.homebridge)', (p) => planImport(String(p.path ?? '~/.homebridge'), readStored()));
    ctx.actions.register(
      'importApply',
      'Apply an import plan: { path, plugins?: string[] (default: all the plan installs), cachedAccessories?: boolean (default true) }',
      async (p) => {
        const plan = planImport(String(p.path ?? '~/.homebridge'), readStored());
        const wanted = Array.isArray(p.plugins) ? new Set(p.plugins.map(String)) : undefined;
        const installed: string[] = [];
        const failed: { name: string; error: string }[] = [];
        for (const pl of plan.plugins) {
          if (!pl.install || (wanted && !wanted.has(pl.name))) continue;
          try {
            const spec = pl.version ? `${pl.name}@${pl.version}` : pl.name;
            let record;
            try {
              record = await installer.install({ spec });
            } catch (err) {
              // The exact version may be gone from the registry: take the latest.
              if (!pl.version) throw err;
              record = await installer.install({ spec: pl.name });
            }
            installed.push(`${record.name}@${record.version}`);
          } catch (err) {
            failed.push({ name: pl.name, error: (err as Error).message });
          }
        }
        const current = readStored();
        writeStored({ platforms: [...current.platforms, ...plan.platforms.map((x) => x.block)], accessories: [...current.accessories, ...plan.accessories.map((x) => x.block)] });
        let cached = 0;
        if (p.cachedAccessories !== false && plan.cachedAccessories) {
          runtime.saveCache();
          const ours = JSON.parse(readFileSync(runtime.cacheFile, 'utf8')) as SerializedPlatformAccessory[];
          const { merged, added } = mergeCachedAccessories(plan.source, ours);
          writeFileSync(runtime.cacheFile, JSON.stringify(merged), { mode: 0o600 });
          cached = added;
        }
        return { source: expandHome(String(p.path ?? '~/.homebridge')), installed, failed, platforms: plan.platforms.length, accessories: plan.accessories.length, cachedAccessories: cached, ...restartNote };
      },
    );

    ctx.onStop(async () => {
      await runtime.stop();
      bridge.close();
    });
  },
});
