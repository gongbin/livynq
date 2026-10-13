import { createServer } from 'node:net';
import type { Logger } from '@livynq/core';

/** Embedded MQTT broker (Aedes) so users do not need to install Mosquitto. Loaded lazily. */
export async function startBuiltinBroker(options: { port: number; host?: string; log: Logger }): Promise<{ close: () => Promise<void> }> {
  const { Aedes } = await import('aedes');
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle as never);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve());
  });
  options.log.info({ port: options.port }, 'built-in MQTT broker listening');
  return {
    close: () =>
      new Promise<void>((resolve) => {
        broker.close(() => server.close(() => resolve()));
      }),
  };
}
