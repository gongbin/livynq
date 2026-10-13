import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { DemoAdapter, Home } from '@livynq/core';
import { MqttAdapter, startBuiltinBroker } from '@livynq/adapter-mqtt';
import { HomeKitExporter } from '@livynq/exporter-homekit';
import type { LivynqConfig } from './config.ts';
import { createServer } from './server.ts';
import { VERSION } from './version.ts';

export interface RunningInstance {
  home: Home;
  url: string;
  stop(): Promise<void>;
}

export async function startLivynq(config: LivynqConfig): Promise<RunningInstance> {
  mkdirSync(config.dataDir, { recursive: true });
  const logger = pino({ level: config.logLevel, base: undefined });
  logger.info({ version: VERSION, dataDir: config.dataDir }, 'starting Livynq');

  const home = new Home({ dataDir: config.dataDir, logger });
  const closers: (() => Promise<void>)[] = [];

  if (config.mqtt.broker.builtin) {
    const broker = await startBuiltinBroker({ port: config.mqtt.broker.port, log: logger.child({ module: 'mqtt-broker' }) });
    closers.push(broker.close);
  }
  if (config.demo) home.useAdapter(new DemoAdapter());
  if (config.mqtt.enabled) {
    home.useAdapter(
      new MqttAdapter({ url: config.mqtt.url, username: config.mqtt.username, password: config.mqtt.password, discoveryPrefix: config.mqtt.discoveryPrefix }),
    );
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

  const app = await createServer(home, { logger });
  await home.start();
  await app.listen({ host: config.server.host, port: config.server.port });

  const firstRun = ensureCliToken(home, config.dataDir);
  const url = `http://${lanAddress() ?? 'localhost'}:${config.server.port}`;
  logger.info({ url }, 'Livynq is ready');
  if (firstRun) {
    // Shown once; afterwards use `livynq login-url` on this machine.
    logger.info(`Open the web UI: ${url}/#token=${firstRun}`);
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

function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    const found = addrs?.find((a) => a.family === 'IPv4' && !a.internal);
    if (found) return found.address;
  }
  return undefined;
}
