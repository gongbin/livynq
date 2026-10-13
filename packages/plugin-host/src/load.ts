import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LivynqError, type Adapter } from '@livynq/core';
import { isPluginDefinition } from '@livynq/sdk';
import { InProcessPluginAdapter } from './in-process.ts';
import { ProcessPluginAdapter } from './process-adapter.ts';

/** One entry of `plugins:` in livynq.yaml. */
export interface PluginEntry {
  id?: string;
  /** npm package name, installed under <data>/plugins or shipped with Livynq. */
  module?: string;
  /** Local directory or file (relative to the config file). */
  path?: string;
  config?: Record<string, unknown>;
  isolation?: 'process' | 'in-process';
  enabled?: boolean;
}

export interface ResolvedPlugin {
  id: string;
  file: string;
  isolation: 'process' | 'in-process';
  config: Record<string, unknown>;
}

function entryFromPackage(dir: string): string {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: unknown; main?: string };
  const pick = (e: unknown): string | undefined => {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      return pick(o['.'] ?? o.import ?? o.default ?? o.node);
    }
    return undefined;
  };
  return join(dir, pick(pkg.exports) ?? pkg.main ?? 'index.js');
}

export interface ResolveOptions {
  dataDir: string;
  configDir: string;
  /** Resolves plugins shipped with Livynq (module specifier → entry file); provided by the app that depends on them. */
  resolveBuiltin?: (specifier: string) => string;
}

export function resolvePlugin(entry: PluginEntry, options: ResolveOptions): ResolvedPlugin {
  let file: string | undefined;
  let defaultId: string;
  if (entry.path) {
    const p = isAbsolute(entry.path) ? entry.path : resolve(options.configDir, entry.path);
    if (!existsSync(p)) throw new LivynqError('NOT_FOUND', `Plugin path not found: ${p}`);
    file = existsSync(join(p, 'package.json')) ? entryFromPackage(p) : p;
    defaultId = basename(p).replace(/\.(ts|js|mjs)$/, '');
  } else if (entry.module) {
    const installed = join(options.dataDir, 'plugins', 'node_modules', entry.module);
    if (existsSync(join(installed, 'package.json'))) file = entryFromPackage(installed);
    else {
      try {
        // Plugins shipped with Livynq (e.g. @livynq/plugin-virtual)
        if (!options.resolveBuiltin) throw new Error('no builtin resolver');
        file = options.resolveBuiltin(entry.module);
      } catch {
        throw new LivynqError('NOT_FOUND', `Plugin ${entry.module} is not installed`, `Run: livynq plugin add ${entry.module}`);
      }
    }
    defaultId = entry.module.replace(/^@[^/]+\//, '').replace(/^livynq-plugin-|^plugin-/, '');
  } else {
    throw new LivynqError('INVALID_PARAMS', 'A plugin entry needs "module" or "path"');
  }
  const id = entry.id ?? defaultId;
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) throw new LivynqError('INVALID_PARAMS', `Invalid plugin id "${id}" (lowercase letters, digits, - and _)`);
  if (!existsSync(file)) throw new LivynqError('NOT_FOUND', `Plugin entry file not found: ${file}`);
  return { id, file, isolation: entry.isolation ?? 'process', config: entry.config ?? {} };
}

export async function createPluginAdapter(plugin: ResolvedPlugin): Promise<Adapter> {
  if (plugin.isolation === 'process') return new ProcessPluginAdapter({ id: plugin.id, module: plugin.file, config: plugin.config });
  const mod = (await import(pathToFileURL(plugin.file).href)) as { default?: unknown };
  if (!isPluginDefinition(mod.default)) throw new LivynqError('INVALID_PARAMS', `${plugin.file} must default-export defineAdapter({...})`);
  return new InProcessPluginAdapter(plugin.id, mod.default, plugin.config);
}
