import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, type Home } from '@livynq/core';
import type { LivynqConfig } from '../config.ts';
import type { PluginManager } from '../plugins/manager.ts';

/** Official integrations the "Add device" wizard can switch on without editing YAML. */
export const OFFICIAL: { method: string; module: string; id: string; isolation: 'process' | 'in-process' }[] = [
  { method: 'matter', module: '@livynq/plugin-matter', id: 'matter', isolation: 'process' },
  { method: 'zigbee', module: '@livynq/plugin-zigbee', id: 'zigbee', isolation: 'process' },
  { method: 'zwave', module: '@livynq/plugin-zwave', id: 'zwave', isolation: 'process' },
  { method: 'esphome', module: '@livynq/plugin-esphome', id: 'esphome', isolation: 'process' },
  { method: 'shelly', module: '@livynq/plugin-shelly', id: 'shelly', isolation: 'process' },
  { method: 'hue', module: '@livynq/plugin-hue', id: 'hue', isolation: 'process' },
  { method: 'xiaomi', module: '@livynq/plugin-xiaomi', id: 'xiaomi', isolation: 'process' },
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
  options: { config?: LivynqConfig; plugins: PluginManager },
): void {
  app.get('/api/v1/onboarding', guards.read, async () => {
    const adapters = home.adapters();
    const config = options.config;
    return {
      methods: [
        ...OFFICIAL.map((o) => {
          const info = (home.adapter(o.id) as { info?: () => { status: string; lastError: string | null } } | undefined)?.info?.();
          const enabled = adapters.includes(o.id);
          return { id: o.method, module: o.module, plugin: o.id, enabled, status: enabled ? (info?.status ?? 'running') : 'off', lastError: info?.lastError ?? null, actions: home.actions(o.id) };
        }),
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
    const row = await options.plugins.enableOfficial(String(body.module ?? ''), body.config);
    return reply.status(201).send({ id: row.id, enabled: true, status: row.status, lastError: row.lastError, actions: row.actions });
  });

  // Reconfigure a plugin (e.g. wrong Zigbee serial port): restart it with the new config.
  app.patch('/api/v1/plugins/:id', guards.admin, async (req) => {
    const pluginId = (req.params as { id: string }).id;
    if (!home.adapters().includes(pluginId)) throw new LivynqError('NOT_FOUND', `Plugin ${pluginId} is not enabled`);
    const row = await options.plugins.configure(pluginId, ((req.body ?? {}) as { config?: Record<string, unknown> }).config ?? {});
    return { id: pluginId, status: row.status, lastError: row.lastError, actions: row.actions };
  });

  // Stop and forget a plugin; ?uninstall=true also deletes files installed from npm or a file.
  app.delete('/api/v1/plugins/:id', guards.admin, async (req, reply) => {
    const pluginId = (req.params as { id: string }).id;
    const q = req.query as { uninstall?: string };
    await options.plugins.remove(pluginId, { uninstall: q.uninstall === 'true' || q.uninstall === '1' });
    return reply.status(204).send();
  });
}

