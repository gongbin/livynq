import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import { createPluginAdapter, resolvePlugin, type PluginEntry } from '@livynq/plugin-host';
import type { PluginDefinition } from '@livynq/sdk';
import { updatePluginsInConfig, type LivynqConfig } from '../config.ts';

/** Official integrations the "Add device" wizard can switch on without editing YAML. */
const OFFICIAL: { method: string; module: string; id: string; isolation: 'process' | 'in-process' }[] = [
  { method: 'matter', module: '@livynq/plugin-matter', id: 'matter', isolation: 'process' },
  { method: 'zigbee', module: '@livynq/plugin-zigbee', id: 'zigbee', isolation: 'process' },
  { method: 'esphome', module: '@livynq/plugin-esphome', id: 'esphome', isolation: 'process' },
  { method: 'homeassistant', module: '@livynq/plugin-homeassistant', id: 'homeassistant', isolation: 'in-process' },
  { method: 'virtual', module: '@livynq/plugin-virtual', id: 'virtual', isolation: 'in-process' },
];

/** Serial devices that may be Zigbee / Z-Wave sticks (stable by-id paths on Linux). */
export function listSerialPorts(): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  const byId = '/dev/serial/by-id';
  if (existsSync(byId)) {
    for (const name of readdirSync(byId)) out.push({ path: join(byId, name), label: name.replace(/^usb-/, '').replace(/-if\d+.*$/, '').replace(/_/g, ' ') });
  }
  if (existsSync('/dev')) {
    for (const name of readdirSync('/dev')) {
      if (!/^(ttyUSB|ttyACM|ttyAMA|cu\.usbserial|cu\.usbmodem|cu\.SLAB|cu\.wchusbserial)/.test(name)) continue;
      const path = join('/dev', name);
      if (out.some((p) => safeReal(p.path) === path)) continue;
      out.push({ path, label: name });
    }
  }
  return out;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  home: Home,
  guards: { read: { preHandler: preHandlerAsyncHookHandler }; admin: { preHandler: preHandlerAsyncHookHandler } },
  options: { config?: LivynqConfig; bundledPlugins?: Record<string, PluginDefinition> },
): void {
  app.get('/api/v1/onboarding', guards.read, async () => {
    const adapters = home.adapters();
    const config = options.config;
    return {
      methods: [
        ...OFFICIAL.map((o) => ({ id: o.method, module: o.module, plugin: o.id, enabled: adapters.includes(o.id), actions: home.actions(o.id) })),
        {
          id: 'mqtt',
          enabled: adapters.includes('mqtt'),
          broker: config ? { url: config.mqtt.url || null, builtin: config.mqtt.broker.builtin, port: config.mqtt.broker.port, discoveryPrefix: config.mqtt.discoveryPrefix } : null,
        },
      ],
      homekit: { enabled: Boolean(home.exporter('homekit')) },
      matterBridge: { enabled: Boolean(home.exporter('matter')) },
    };
  });

  app.get('/api/v1/system/serial-ports', guards.admin, async () => listSerialPorts());

  // Enable an official integration now (and persist it in livynq.yaml).
  app.post('/api/v1/plugins', guards.admin, async (req, reply) => {
    const body = (req.body ?? {}) as { module?: string; config?: Record<string, unknown> };
    const official = OFFICIAL.find((o) => o.module === body.module);
    if (!official) throw new LivynqError('INVALID_PARAMS', `Only official plugins can be enabled here (${OFFICIAL.map((o) => o.module).join(', ')}); use \`livynq plugin add\` for others`);
    if (home.adapters().includes(official.id)) throw new LivynqError('CONFLICT', `${official.id} is already enabled`);
    const entry: PluginEntry = { module: official.module, isolation: official.isolation, ...(body.config && Object.keys(body.config).length ? { config: body.config } : {}) };
    const dataDir = home.dataDir;
    const resolved = resolvePlugin(entry, {
      dataDir,
      configDir: options.config ? dirname(options.config.configFile) : dataDir,
      resolveBuiltin: (specifier) => fileURLToPath(import.meta.resolve(specifier)),
      bundled: options.bundledPlugins,
    });
    await home.addAdapter(await createPluginAdapter(resolved));
    if (options.config) updatePluginsInConfig(options.config.configFile, { add: entry });
    return reply.status(201).send({ id: resolved.id, enabled: true, actions: home.actions(resolved.id) });
  });
}
