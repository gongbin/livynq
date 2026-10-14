import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import { DemoAdapter, Home, writeAutomaticBackup } from '@livynq/core';
import { MqttAdapter, startBuiltinBroker } from '@livynq/adapter-mqtt';
import { HomeKitExporter } from '@livynq/exporter-homekit';
import { AutomationEngine } from '@livynq/automation';
import { MatterExporter } from '@livynq/exporter-matter';
import { createPluginAdapter, resolvePlugin } from '@livynq/plugin-host';
import type { PluginDefinition } from '@livynq/sdk';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LivynqConfig } from './config.ts';
import { createServer } from './server.ts';
import { startDemoCamera } from './demo/camera.ts';
import { PluginInstaller, pluginsDir } from './plugins/installer.ts';
import { VERSION } from './version.ts';

export interface RunningInstance {
  home: Home;
  url: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Plugins compiled into a single-executable build. */
  bundledPlugins?: Record<string, PluginDefinition>;
}

export async function startLivynq(config: LivynqConfig, options: StartOptions = {}): Promise<RunningInstance> {
  mkdirSync(config.dataDir, { recursive: true });
  const logger = pino({ level: config.logLevel, base: undefined });
  logger.info({ version: VERSION, dataDir: config.dataDir }, 'starting Livynq');

  const home = new Home({ dataDir: config.dataDir, logger });
  const closers: (() => Promise<void>)[] = [];

  if (config.mqtt.broker.builtin) {
    const broker = await startBuiltinBroker({ port: config.mqtt.broker.port, log: logger.child({ module: 'mqtt-broker' }) });
    closers.push(broker.close);
  }
  if (config.demo) {
    home.useAdapter(new DemoAdapter());
    const camera = await startDemoCamera();
    home.useAdapter(camera.adapter);
    closers.push(async () => camera.close());
  }
  if (config.mqtt.enabled) {
    home.useAdapter(
      new MqttAdapter({ url: config.mqtt.url, username: config.mqtt.username, password: config.mqtt.password, discoveryPrefix: config.mqtt.discoveryPrefix }),
    );
  }
  // Running as a Home Assistant add-on: bridge HA's entities automatically (Supervisor provides the token).
  const plugins = [...config.plugins];
  if (process.env.SUPERVISOR_TOKEN && !plugins.some((p) => p.module === '@livynq/plugin-homeassistant')) {
    plugins.push({ module: '@livynq/plugin-homeassistant', isolation: 'in-process' });
    logger.info('Home Assistant add-on detected: bridging Home Assistant entities');
  }
  try {
    // Installed plugins re-export this hub's SDK; a newer hub may export more.
    new PluginInstaller({ dir: pluginsDir(config.dataDir), hubVersion: VERSION }).refreshShims();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'could not refresh plugin SDK shims');
  }
  for (const entry of plugins) {
    if (entry.enabled === false) continue;
    try {
      const plugin = resolvePlugin(entry, {
        dataDir: config.dataDir,
        configDir: dirname(config.configFile),
        resolveBuiltin: (specifier) => fileURLToPath(import.meta.resolve(specifier)),
        bundled: options.bundledPlugins,
      });
      home.useAdapter(await createPluginAdapter(plugin));
      logger.info({ plugin: plugin.id, isolation: plugin.isolation }, 'plugin registered');
    } catch (err) {
      logger.error({ entry, err: (err as Error).message }, 'plugin could not be loaded');
    }
  }
  if (config.homekit.enabled) {
    home.useExporter(
      new HomeKitExporter({
        name: config.homekit.name,
        port: config.homekit.port,
        pincode: config.homekit.pincode,
        bind: config.homekit.bind,
        storagePath: join(config.dataDir, 'secrets', 'hap'),
        firmwareRevision: VERSION,
      }),
    );
  }

  if (config.matter.bridge.enabled) {
    home.useExporter(
      new MatterExporter({
        storagePath: join(config.dataDir, 'secrets', 'matter'),
        port: config.matter.bridge.port,
        passcode: config.matter.bridge.passcode,
        discriminator: config.matter.bridge.discriminator,
        networkInterface: config.matter.networkInterface,
      }),
    );
  }
  home.useExtension(new AutomationEngine({ location: config.location }));
  if (!config.location) logger.info('no location configured: sun triggers/conditions are inactive (set location.latitude/longitude in livynq.yaml)');

  const app = await createServer(home, { logger, config, bundledPlugins: options.bundledPlugins });
  await home.start();
  await app.listen({ host: config.server.host, port: config.server.port });
  if (config.server.https) closers.push(await listenHttps(app, config.server.host, config.server.https, logger));

  const firstRun = ensureCliToken(home, config.dataDir);
  const url = `http://${lanAddress() ?? 'localhost'}:${config.server.port}`;
  logger.info({ url }, 'Livynq is ready');
  if (firstRun) {
    // Shown once; afterwards use `livynq login-url` on this machine.
    logger.info(`Open the web UI: ${url}/#token=${firstRun}`);
  }

  if (config.backup.automatic) {
    const backup = () => {
      try {
        logger.info({ file: writeAutomaticBackup(home, VERSION, config.backup.keep) }, 'automatic backup written');
      } catch (err) {
        logger.error({ err }, 'automatic backup failed');
      }
    };
    const first = setTimeout(backup, 10 * 60_000).unref();
    const daily = setInterval(backup, 24 * 3600_000).unref();
    closers.push(async () => {
      clearTimeout(first);
      clearInterval(daily);
    });
  }

  return {
    home,
    url,
    async stop() {
      await app.close();
      await home.stop();
      for (const close of closers.reverse()) await close();
      logger.info('stopped');
    },
  };
}

/**
 * The local CLI authenticates with an admin token stored next to the database (0600),
 * like a Unix socket would. Returns the token when a new one was created.
 */
function ensureCliToken(home: Home, dataDir: string): string | undefined {
  const dir = join(dataDir, 'secrets');
  const file = join(dir, 'cli.token');
  if (existsSync(file) && home.tokens.verify(readFileSync(file, 'utf8').trim())) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { token } = home.tokens.create('local-cli', 'admin');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** Second listener with TLS, routed into the same Fastify app (HTTP and WebSocket upgrades). */
async function listenHttps(app: FastifyInstance, host: string, tls: { port: number; cert: string; key: string }, logger: Logger): Promise<() => Promise<void>> {
  const server = createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, (req, res) => app.routing(req, res));
  server.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(tls.port, host, () => resolve()));
  logger.info({ port: tls.port }, 'https listening');
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    const found = addrs?.find((a) => a.family === 'IPv4' && !a.internal);
    if (found) return found.address;
  }
  return undefined;
}
