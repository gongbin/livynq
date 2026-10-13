import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DemoAdapter, Home } from '@livynq/core';
import { HomeKitExporter } from '@livynq/exporter-homekit';

export async function run(dir: string, port: number, mutate?: (home: Home) => void, maxAccessoriesPerBridge?: number) {
  const home = new Home({ dataDir: dir });
  const exporter = new HomeKitExporter({ name: 'Test Bridge', port, storagePath: join(dir, 'secrets', 'hap'), bind: ['127.0.0.1'], maxAccessoriesPerBridge });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExporter(exporter);
  await home.start();
  mutate?.(home);
  // HAP assigns AIDs in a debounced configuration update; wait for it (also lets mDNS finish announcing).
  const deadline = Date.now() + 10_000;
  while (Object.values(exporter.accessoryIds()).some((aid) => aid === undefined) && Date.now() < deadline) await sleep(100);
  // ciao leaks its socket when shut down mid-announcement, which only happens in rapid test restarts.
  await sleep(1500);
  const ids = exporter.accessoryIds();
  const bridges = exporter.bridges();
  const bridge = bridges[0]!;
  const assignments = exporter.assignments();
  await home.stop();
  return { ids, bridge, bridges, assignments };
}

