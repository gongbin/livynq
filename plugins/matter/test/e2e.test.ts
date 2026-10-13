import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DemoAdapter, Home } from '@livynq/core';
import { ProcessPluginAdapter } from '@livynq/plugin-host';
import { MatterExporter } from '@livynq/exporter-matter';

async function until(fn: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(100);
  }
}

// Livynq A exposes its demo devices as a Matter bridge; Livynq B commissions it with the Matter
// controller plugin (separate process) and controls A's devices over real Matter on localhost.
// Keep Matter discovery on loopback: hosts with VPN/tunnel interfaces otherwise try unreachable link-local addresses first.
process.env.MATTER_MDNS_NETWORKINTERFACE ??= process.platform === 'darwin' ? 'lo0' : 'lo';

// Needs multicast on loopback, which CI runners may not offer; run it locally or with LIVYNQ_MATTER_E2E=1.
const skip = Boolean(process.env.CI) && !process.env.LIVYNQ_MATTER_E2E;

test('Matter controller commissions a Matter bridge and controls its bridged devices', { timeout: 120_000, skip }, async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'livynq-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'livynq-b-'));
  const port = 5700 + Math.floor(Math.random() * 200);
  const a = new Home({ dataDir: dirA });
  const bridge = new MatterExporter({ storagePath: join(dirA, 'matter'), port });
  a.useAdapter(new DemoAdapter({ simulateSensors: false })).useExporter(bridge);
  const b = new Home({ dataDir: dirB });
  const controller = new ProcessPluginAdapter({ id: 'matter', module: fileURLToPath(new URL('../src/index.ts', import.meta.url)) });
  b.useAdapter(controller);
  try {
    await a.start();
    await bridge.settled();
    await b.start();
    await until(() => controller.info().status === 'running', 20_000);

    const result = (await b.invokeAction('matter', 'commission', { code: bridge.info().manualPairingCode, ip: '127.0.0.1', port }, 'test')) as { nodeId: string };
    assert.match(result.nodeId, /^\d+$/);
    assert.equal(bridge.info().commissioned, true);

    // Every bridged node becomes its own Livynq device.
    await until(() => b.registry.listDevices().filter((d) => d.protocol === 'matter').length >= 8, 60_000);
    const lamp = b.registry.listDevices().find((d) => d.name === 'Bedroom Lamp')!;
    assert.ok(lamp, 'bridged device names come from BridgedDeviceBasicInformation');
    assert.equal(lamp.endpoints[0]!.deviceType, 'light.dimmable');

    await b.command({ deviceId: lamp.id, endpointId: lamp.endpoints[0]!.id, capability: 'onOff', command: 'on' }, 'test');
    await until(() => a.registry.getAttribute('demo:bedroom-lamp', 1, 'onOff', 'onOff') === true, 15_000);
    await until(() => b.registry.getAttribute(lamp.id, lamp.endpoints[0]!.id, 'onOff', 'onOff') === true, 15_000);

    // State changes on A flow to B through the Matter subscription.
    a.registry.updateState('demo:bedroom-climate', 1, 'temperatureMeasurement', { measuredValue: 18.5 }, 'test');
    const temp = b.registry.listDevices().find((d) => d.endpoints.some((e) => e.deviceType === 'sensor.temperature'))!;
    await until(() => b.registry.getAttribute(temp.id, temp.endpoints.find((e) => e.deviceType === 'sensor.temperature')!.id, 'temperatureMeasurement', 'measuredValue') === 18.5, 20_000);
  } finally {
    await b.stop();
    await a.stop();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
