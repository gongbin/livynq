import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SerializedPlatformAccessory } from './api.ts';
import { findPluginDirs, pluginSchema, type Block, type HomebridgeConfig } from './runtime.ts';

/**
 * Reads an existing Homebridge storage directory (~/.homebridge, /var/lib/homebridge, the
 * Homebridge Docker volume …) and plans the move: which plugins to install, which platform /
 * accessory blocks to copy, and what is left behind.
 */

export interface ImportPlan {
  source: string;
  plugins: { name: string; version?: string; install: boolean; reason?: string }[];
  platforms: { block: Block; plugin?: string; note?: string }[];
  accessories: { block: Block; plugin?: string; note?: string }[];
  /** Cached platform accessories (keep plugin state such as tokens and stable ids) */
  cachedAccessories: number;
  ignored: string[];
  warnings: string[];
}

/** Homebridge UI and other plugins that make no sense inside Livynq. */
const SKIP_PLUGINS: Record<string, string> = {
  'homebridge-config-ui-x': 'Homebridge UI — Livynq has its own web UI',
  'homebridge-alexa': 'Alexa cloud skill bridge — use Livynq’s Matter bridge for Alexa',
  'homebridge-gsh': 'Google Smart Home bridge — use Livynq’s Matter bridge for Google Home',
};
const SKIP_PLATFORMS = new Set(['config']);

export const expandHome = (p: string) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

export function planImport(path: string, existing: HomebridgeConfig = { platforms: [], accessories: [] }): ImportPlan {
  const dir = expandHome(path);
  const configFile = join(dir, 'config.json');
  if (!existsSync(configFile)) throw new Error(`${configFile} not found — point to the Homebridge storage directory (e.g. ~/.homebridge)`);
  let config: { bridge?: unknown; ports?: unknown; mdns?: unknown; platforms?: Block[]; accessories?: Block[]; plugins?: string[]; disabledPlugins?: string[] };
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8')) as typeof config;
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  const warnings: string[] = [];
  const ignored: string[] = [];
  if (config.bridge) ignored.push('bridge (name, user name, PIN, port): Livynq publishes its own HomeKit and Matter bridges; pair those instead');
  if (config.ports) ignored.push('ports');
  if (config.mdns) ignored.push('mdns');
  if (Array.isArray(config.plugins)) ignored.push('plugins (allow-list): every installed plugin is loaded');

  // Installed plugins: hb-service's package.json and what is actually in node_modules.
  const versions = new Map<string, string | undefined>();
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) if (/^(@[^/]+\/)?homebridge-/.test(name)) versions.set(name, range.replace(/^[\^~]/, ''));
  } catch {
    // no package.json (global npm install)
  }
  const aliases = new Map<string, string>();
  for (const pdir of findPluginDirs(join(dir, 'node_modules'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(pdir, 'package.json'), 'utf8')) as { name: string; version: string };
      versions.set(pkg.name, pkg.version);
      const schema = pluginSchema(pdir);
      if (schema.alias) aliases.set(schema.alias, pkg.name);
    } catch {
      // unreadable package
    }
  }
  if (!versions.size) warnings.push('no plugins found next to config.json; plugins installed globally (npm -g) are not visible — add them by name');

  const disabled = new Set(config.disabledPlugins ?? []);
  const plugins = [...versions].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => {
    const skip = SKIP_PLUGINS[name];
    if (skip) return { name, ...(version ? { version } : {}), install: false, reason: skip };
    if (disabled.has(name)) return { name, ...(version ? { version } : {}), install: false, reason: 'disabled in Homebridge' };
    return { name, ...(version ? { version } : {}), install: true };
  });

  const same = (a: Block, b: Block) => JSON.stringify(a) === JSON.stringify(b);
  const clean = (b: Block): { block: Block; note?: string } => {
    const { _bridge, ...rest } = b;
    return { block: rest, ...(_bridge ? { note: 'child bridge settings dropped: Livynq runs every plugin in one isolated process' } : {}) };
  };
  const pluginFor = (type: string | undefined) => {
    if (!type) return undefined;
    if (type.includes('.')) return type.slice(0, type.lastIndexOf('.'));
    return aliases.get(type);
  };

  const platforms: ImportPlan['platforms'] = [];
  for (const b of config.platforms ?? []) {
    if (!b || typeof b !== 'object' || typeof b.platform !== 'string') {
      warnings.push('a platform block without a "platform" key was skipped');
      continue;
    }
    if (SKIP_PLATFORMS.has(b.platform)) {
      ignored.push(`platform "${b.platform}" (Homebridge UI)`);
      continue;
    }
    const c = clean(b);
    if (existing.platforms.some((e) => same(e, c.block))) continue;
    const plugin = pluginFor(b.platform);
    platforms.push({ ...c, ...(plugin ? { plugin } : {}) });
  }
  const accessories: ImportPlan['accessories'] = [];
  for (const b of config.accessories ?? []) {
    if (!b || typeof b !== 'object' || typeof b.accessory !== 'string') {
      warnings.push('an accessory block without an "accessory" key was skipped');
      continue;
    }
    const c = clean(b);
    if (existing.accessories.some((e) => same(e, c.block))) continue;
    const plugin = pluginFor(b.accessory);
    accessories.push({ ...c, ...(plugin ? { plugin } : {}) });
  }

  let cachedAccessories = 0;
  try {
    cachedAccessories = (JSON.parse(readFileSync(join(dir, 'accessories', 'cachedAccessories'), 'utf8')) as unknown[]).length;
  } catch {
    // none
  }
  warnings.push('plugins that keep their own files in the Homebridge storage directory (tokens, databases) may need to be signed in again');
  return { source: dir, plugins, platforms, accessories, cachedAccessories, ignored, warnings };
}

/** Cached accessories of the source install, merged by UUID into ours (theirs win for new UUIDs only). */
export function mergeCachedAccessories(sourceDir: string, ours: SerializedPlatformAccessory[]): { merged: SerializedPlatformAccessory[]; added: number } {
  let theirs: SerializedPlatformAccessory[] = [];
  try {
    theirs = JSON.parse(readFileSync(join(expandHome(sourceDir), 'accessories', 'cachedAccessories'), 'utf8')) as SerializedPlatformAccessory[];
  } catch {
    return { merged: ours, added: 0 };
  }
  const known = new Set(ours.map((a) => a.UUID));
  const added = theirs.filter((a) => a && typeof a.UUID === 'string' && !known.has(a.UUID));
  return { merged: [...ours, ...added], added: added.length };
}
