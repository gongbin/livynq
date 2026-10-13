import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface LivynqConfig {
  dataDir: string;
  server: { host: string; port: number };
  demo: boolean;
  homekit: { enabled: boolean; name: string; port: number; pincode?: string; bind?: string[] };
  mqtt: { enabled: boolean; url: string; username?: string; password?: string; discoveryPrefix: string; broker: { builtin: boolean; port: number } };
  logLevel: string;
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
  };
}
