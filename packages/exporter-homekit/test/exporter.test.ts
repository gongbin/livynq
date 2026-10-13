import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DemoAdapter, Home } from '@livynq/core';
import { HomeKitExporter } from '@livynq/exporter-homekit';

async function run(dir: string, port: number, mutate?: (home: Home) => void) {
  const home = new Home({ dataDir: dir });
  const exporter = new HomeKitExporter({ name: 'Test Bridge', port, storagePath: join(dir, 'secrets', 'hap'), bind: ['127.0.0.1'] });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExporter(exporter);
  await home.start();
  mutate?.(home);
  // HAP assigns AIDs in a debounced configuration update; wait for it (also lets mDNS finish announcing).
  const deadline = Date.now() + 10_000;
  while (Object.values(exporter.accessoryIds()).some((aid) => aid === undefined) && Date.now() < deadline) await sleep(100);
  // ciao leaks its socket when shut down mid-announcement, which only happens in rapid test restarts.
  await sleep(1500);
  const ids = exporter.accessoryIds();
  const bridge = exporter.bridges()[0]!;
  await home.stop();
  return { ids, bridge };
}

test('bridge identity and accessory ids are stable across restarts and removals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-hap-'));
  const port = 52000 + Math.floor(Math.random() * 1000);
  try {
    const first = await run(dir, port);
    assert.equal(Object.keys(first.ids).length, 6);
    assert.match(first.bridge.pincode, /^\d{3}-\d{2}-\d{3}$/);
    assert.match(first.bridge.setupURI, /^X-HM:\/\//);

    // Hide one device from HomeKit and restart: the others keep their ids.
    const second = await run(dir, port, (home) => home.registry.updateDevice('demo:coffee-plug', { exposure: { homekit: false } }));
    assert.equal(second.ids['demo:coffee-plug'], undefined);
    const third = await run(dir, port, (home) => home.registry.updateDevice('demo:coffee-plug', { exposure: { homekit: true } }));
    assert.deepEqual(third.ids, first.ids, 'every device, including the re-exposed one, keeps its AID');
    assert.equal(third.bridge.setupURI, first.bridge.setupURI);
    assert.equal(third.bridge.pincode, first.bridge.pincode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
