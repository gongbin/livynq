import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMap, isSeq, parse, parseDocument, type YAMLSeq } from 'yaml';
import { writeFileSync } from 'node:fs';
import type { PluginEntry } from '@livynq/plugin-host';

export interface LivynqConfig {
  dataDir: string;
  /**
   * `https` adds a second, TLS listener (phones only allow push notifications and installing the
   * web app on https). Paths are relative to the data directory. The plain port keeps serving the
   * CLI and local tools.
   */
  server: { host: string; port: number; https?: { port: number; cert: string; key: string } };
  demo: boolean;
  homekit: { enabled: boolean; name: string; port: number; pincode?: string; bind?: string[] };
  mqtt: { enabled: boolean; url: string; username?: string; password?: string; discoveryPrefix: string; broker: { builtin: boolean; port: number } };
  logLevel: string;
  location?: { latitude: number; longitude: number };
  backup: { automatic: boolean; keep: number };
  matter: { bridge: { enabled: boolean; port: number; passcode?: number; discriminator?: number }; networkInterface?: string };
  plugins: PluginEntry[];
  /** npm registry the plugin installer uses (`npmRegistry` in livynq.yaml, env LIVYNQ_NPM_REGISTRY). */
  npmRegistry: string;
  configFile: string;
}

export interface ConfigOverrides {
  dataDir?: string;
  port?: number;
  host?: string;
  demo?: boolean;
  homekit?: boolean;
  mqttUrl?: string;
  builtinBroker?: boolean;
  logLevel?: string;
  matter?: boolean;
}

export function defaultDataDir(): string {
  return process.env.LIVYNQ_DATA_DIR ?? join(homedir(), '.livynq');
}

/** Defaults < `<dataDir>/livynq.yaml` < environment < CLI flags. */
export function loadConfig(overrides: ConfigOverrides = {}): LivynqConfig {
  const dataDir = resolve(overrides.dataDir ?? defaultDataDir());
  const file = join(dataDir, 'livynq.yaml');
  const yaml = existsSync(file) ? ((parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, any>) : {};
  const env = process.env;

  const builtin = overrides.builtinBroker ?? yaml.mqtt?.broker?.builtin ?? false;
  const brokerPort = yaml.mqtt?.broker?.port ?? 1883;
  const mqttUrl = overrides.mqttUrl ?? env.LIVYNQ_MQTT_URL ?? yaml.mqtt?.url ?? (builtin ? `mqtt://127.0.0.1:${brokerPort}` : '');

  return {
    dataDir,
    server: {
      host: overrides.host ?? env.LIVYNQ_HOST ?? yaml.server?.host ?? '0.0.0.0',
      port: overrides.port ?? (env.LIVYNQ_PORT ? Number(env.LIVYNQ_PORT) : undefined) ?? yaml.server?.port ?? 8581,
      ...(yaml.server?.https?.cert && yaml.server?.https?.key
        ? { https: { port: Number(yaml.server.https.port ?? 8582), cert: resolve(dataDir, String(yaml.server.https.cert)), key: resolve(dataDir, String(yaml.server.https.key)) } }
        : {}),
    },
    demo: overrides.demo ?? yaml.demo ?? false,
    homekit: {
      enabled: overrides.homekit ?? yaml.homekit?.enabled ?? true,
      name: yaml.homekit?.name ?? 'Livynq Bridge',
      port: yaml.homekit?.port ?? 51826,
      pincode: yaml.homekit?.pincode,
      bind: yaml.homekit?.bind,
    },
    mqtt: {
      enabled: Boolean(mqttUrl),
      url: mqttUrl,
      username: env.LIVYNQ_MQTT_USERNAME ?? yaml.mqtt?.username,
      password: env.LIVYNQ_MQTT_PASSWORD ?? yaml.mqtt?.password,
      discoveryPrefix: yaml.mqtt?.discoveryPrefix ?? 'homeassistant',
      broker: { builtin, port: brokerPort },
    },
    logLevel: overrides.logLevel ?? env.LIVYNQ_LOG_LEVEL ?? yaml.logLevel ?? 'info',
    matter: {
      bridge: {
        enabled: overrides.matter ?? yaml.matter?.bridge?.enabled ?? false,
        port: Number(yaml.matter?.bridge?.port ?? 5540),
        passcode: yaml.matter?.bridge?.passcode,
        discriminator: yaml.matter?.bridge?.discriminator,
      },
      networkInterface: yaml.matter?.networkInterface,
    },
    plugins: Array.isArray(yaml.plugins) ? (yaml.plugins as PluginEntry[]) : [],
    npmRegistry: String(env.LIVYNQ_NPM_REGISTRY ?? yaml.npmRegistry ?? 'https://registry.npmjs.org').replace(/\/$/, ''),
    configFile: file,
    backup: { automatic: yaml.backup?.automatic ?? true, keep: Number(yaml.backup?.keep ?? 7) },
    location:
      Number.isFinite(Number(yaml.location?.latitude)) && Number.isFinite(Number(yaml.location?.longitude))
        ? { latitude: Number(yaml.location.latitude), longitude: Number(yaml.location.longitude) }
        : undefined,
  };
}

/** The `plugins:` entries currently in livynq.yaml (re-read; the UI and CLI edit it at runtime). */
export function readPluginEntries(file: string): PluginEntry[] {
  if (!existsSync(file)) return [];
  const yaml = (parse(readFileSync(file, 'utf8')) ?? {}) as { plugins?: unknown };
  return Array.isArray(yaml.plugins) ? (yaml.plugins as PluginEntry[]).filter((p) => p && typeof p === 'object') : [];
}

/**
 * Adds or removes `plugins:` entries in livynq.yaml, editing the YAML node in place so
 * the user's comments and formatting elsewhere survive.
 */
export function updatePluginsInConfig(file: string, change: { add?: PluginEntry; remove?: (entry: PluginEntry) => boolean }): number {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '');
  if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0]!.message}`);
  let seq = doc.get('plugins', true);
  if (!isSeq(seq)) {
    seq = doc.createNode([]);
    doc.set('plugins', seq);
  }
  const items = (seq as YAMLSeq).items;
  let removed = 0;
  const matches = (entry: PluginEntry) => (change.remove?.(entry) ?? false) || (change.add !== undefined && (entry.module ?? entry.path) === (change.add.module ?? change.add.path));
  for (let i = items.length - 1; i >= 0; i--) {
    const node = items[i];
    const entry = (isMap(node) ? node.toJSON() : {}) as PluginEntry;
    if (matches(entry)) {
      items.splice(i, 1);
      if (change.remove?.(entry)) removed++;
    }
  }
  if (change.add) (seq as YAMLSeq).add(doc.createNode(change.add));
  writeFileSync(file, doc.toString());
  return removed;
}
