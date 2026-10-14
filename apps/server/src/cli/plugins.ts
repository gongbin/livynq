import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pluginIdFor, type PluginEntry } from '@livynq/plugin-host';
import { readPluginEntries, updatePluginsInConfig, type LivynqConfig } from '../config.ts';
import { PluginInstaller, pluginsDir, type InstalledRecord } from '../plugins/installer.ts';
import { VERSION } from '../version.ts';
import { ApiError, type RemoteClient } from './remote.ts';

/**
 * `livynq plugin add | remove | upgrade`. With a running hub the change is applied live through
 * the API; otherwise the built-in installer works on the data directory and the plugin loads on
 * the next start. No npm needed either way.
 */

type Out = { text: string; data: unknown };

/** Runs fn against the running hub; undefined when there is none (or no token yet). */
async function viaHub<T>(client: () => RemoteClient, fn: (c: RemoteClient) => Promise<T>): Promise<T | undefined> {
  let c: RemoteClient;
  try {
    c = client();
  } catch {
    return undefined;
  }
  try {
    return await fn(c);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNREACHABLE') return undefined;
    throw err;
  }
}

const isTarball = (t: string) => /\.(tgz|tar\.gz)$/i.test(t) && existsSync(t) && statSync(t).isFile();
const isDir = (t: string) => (t.startsWith('.') || t.startsWith('/')) && !isTarball(t);

function warningsText(w: string[] | undefined): string {
  return w?.length ? `\n${w.map((x) => `  ! ${x}`).join('\n')}` : '';
}

export async function pluginAdd(config: LivynqConfig, client: () => RemoteClient, target: string, options: { isolation?: 'process' | 'in-process' }): Promise<Out> {
  if (isDir(target)) {
    // A plugin under development: referenced in place, loaded on the next start.
    const entry: PluginEntry = { path: resolve(target), ...(options.isolation ? { isolation: options.isolation } : {}) };
    updatePluginsInConfig(config.configFile, { add: entry });
    return { text: `added ${entry.path} to ${config.configFile}; restart Livynq to load it`, data: { ok: true, entry } };
  }
  const tarball = isTarball(target) ? readFileSync(target) : undefined;
  const live = await viaHub(client, (c) =>
    tarball
      ? c.upload<{ id: string; version: string; status: string; warnings?: string[] }>(`/api/v1/plugins/install?filename=${encodeURIComponent(basename(target))}${options.isolation ? `&isolation=${options.isolation}` : ''}`, tarball)
      : c.request<{ id: string; version: string; status: string; warnings?: string[] }>('POST', '/api/v1/plugins/install', { spec: target, ...(options.isolation ? { isolation: options.isolation } : {}) }),
  );
  if (live) return { text: `installed ${live.id} ${live.version}: ${live.status}${warningsText(live.warnings)}`, data: live };

  const installer = new PluginInstaller({ dir: pluginsDir(config.dataDir), hubVersion: VERSION, registry: config.npmRegistry });
  const plan = await installer.resolve(tarball ? { tarball, filename: basename(target) } : { spec: target });
  const record = await installer.install(plan);
  const entry: PluginEntry = { module: record.name, ...(options.isolation ? { isolation: options.isolation } : {}) };
  const existing = readPluginEntries(config.configFile).find((e) => e.module === record.name);
  updatePluginsInConfig(config.configFile, { add: { ...existing, ...entry } });
  return { text: `installed ${record.name} ${record.version} (${record.packages} packages); it starts with Livynq${warningsText(plan.warnings)}`, data: { ok: true, record, warnings: plan.warnings } };
}

export async function pluginRemove(config: LivynqConfig, client: () => RemoteClient, id: string): Promise<Out> {
  const live = await viaHub(client, async (c) => {
    await c.request('DELETE', `/api/v1/plugins/${encodeURIComponent(id)}?uninstall=true`);
    return true;
  });
  if (live) return { text: `removed ${id}`, data: { ok: true } };
  const entry = readPluginEntries(config.configFile).find((e) => pluginIdFor(e) === id || e.module === id);
  if (!entry) throw new ApiError(404, 'NOT_FOUND', `No plugin "${id}" in ${config.configFile}`);
  updatePluginsInConfig(config.configFile, { remove: (e) => (e.module ?? e.path) === (entry.module ?? entry.path) });
  const uninstalled = entry.module ? new PluginInstaller({ dir: pluginsDir(config.dataDir), hubVersion: VERSION }).uninstall(entry.module) : false;
  return { text: `removed ${id}${uninstalled ? ' and its files' : ''}`, data: { ok: true, uninstalled } };
}

export async function pluginUpgrade(config: LivynqConfig, client: () => RemoteClient, id: string): Promise<Out> {
  const live = await viaHub(client, (c) => c.request<{ id: string; version: string; from: string | null; upgraded: boolean; warnings?: string[] }>('POST', `/api/v1/plugins/${encodeURIComponent(id)}/upgrade`, {}));
  if (live) return { text: live.upgraded ? `upgraded ${id} ${live.from ?? '?'} → ${live.version}${warningsText(live.warnings)}` : `${id} ${live.version} is up to date`, data: live };
  const entry = readPluginEntries(config.configFile).find((e) => pluginIdFor(e) === id || e.module === id);
  if (!entry?.module) throw new ApiError(404, 'NOT_FOUND', `No installed plugin "${id}"`);
  const installer = new PluginInstaller({ dir: pluginsDir(config.dataDir), hubVersion: VERSION, registry: config.npmRegistry });
  const record: InstalledRecord | undefined = installer.installed()[entry.module];
  if (!record) throw new ApiError(400, 'NOT_SUPPORTED', `${id} ships with Livynq; it is upgraded together with Livynq`);
  if (record.source === 'file') throw new ApiError(400, 'NOT_SUPPORTED', `${id} was installed from a file; install the new file instead`);
  const from = installer.installedVersion(entry.module);
  const plan = await installer.resolve({ spec: `${entry.module}@latest` });
  if (plan.root.version === from) return { text: `${id} ${from} is up to date`, data: { upgraded: false, version: from } };
  const next = await installer.install(plan);
  return { text: `upgraded ${id} ${from ?? '?'} → ${next.version}; restart Livynq to load it${warningsText(plan.warnings)}`, data: { upgraded: true, from, version: next.version } };
}
