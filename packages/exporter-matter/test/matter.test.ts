import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DemoAdapter, Home } from '@livynq/core';
import { MatterExporter } from '@livynq/exporter-matter';

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

test('Matter bridge publishes Livynq devices and routes controller changes back as commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-matter-'));
  const home = new Home({ dataDir: dir });
  const matter = new MatterExporter({ storagePath: join(dir, 'secrets', 'matter'), port: 5600 + Math.floor(Math.random() * 300), forwardLocalChanges: true });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExporter(matter);
  try {
    await home.start();
    await matter.settled();
    assert.equal(matter.info().deviceCount, 11, 'every bridgeable demo endpoint (not the button or battery-only ones)');
    const info = matter.info();
    assert.equal(info.enabled, true);
    assert.equal(info.commissioned, false);
    assert.match(info.manualPairingCode!, /^\d{11}$/);
    assert.match(info.qrPairingCode!, /^MT:/);

    const state = (deviceId: string, ep = 1) => matter.endpoint(deviceId, ep)!.state as unknown as Record<string, Record<string, unknown>>;
    // Livynq → Matter
    assert.equal(state('demo:living-ceiling').onOff!.onOff, true);
    assert.equal(state('demo:living-ceiling').levelControl!.currentLevel, 180);
    assert.equal(state('demo:bedroom-climate', 1).temperatureMeasurement!.measuredValue, 2240);
    assert.equal(state('demo:front-door').booleanState!.stateValue, true);
    assert.equal(state('demo:living-curtain').windowCovering!.currentPositionLiftPercent100ths, 0, 'fully open = 0 % closed');
    assert.equal(state('demo:front-lock').doorLock!.lockState, 1);

    await home.command({ deviceId: 'demo:bedroom-lamp', endpointId: 1, capability: 'onOff', command: 'on' }, 'test');
    await until(() => state('demo:bedroom-lamp').onOff!.onOff === true);
    assert.equal(home.recentCommands(1)[0]?.source, 'test', 'state written into Matter is not echoed back as a command');

    // Matter → Livynq (attribute changes)
    await matter.endpoint('demo:coffee-plug', 1)!.set({ onOff: { onOff: true } } as never);
    await until(() => home.registry.getAttribute('demo:coffee-plug', 1, 'onOff', 'onOff') === true);
    assert.equal(home.recentCommands(1)[0]?.source, 'matter');

    // Matter → Livynq (commands handled by behaviors)
    await matter.endpoint('demo:living-curtain', 1)!.act((agent) => (agent as unknown as { windowCovering: { goToLiftPercentage(r: { liftPercent100thsValue: number }): Promise<void> } }).windowCovering.goToLiftPercentage({ liftPercent100thsValue: 7000 }));
    await until(() => home.registry.getAttribute('demo:living-curtain', 1, 'windowCovering', 'targetPosition') === 30);
    await matter.endpoint('demo:front-lock', 1)!.act((agent) => (agent as unknown as { doorLock: { unlockDoor(r: object): Promise<void> } }).doorLock.unlockDoor({}));
    await until(() => home.registry.getAttribute('demo:front-lock', 1, 'doorLock', 'lockState') === 'unlocked');
    await until(() => state('demo:front-lock').doorLock!.lockState === 2);

    // Exposure off removes it from the bridge
    home.registry.updateDevice('demo:office-fan', { exposure: { matter: false } });
    await until(() => matter.endpoint('demo:office-fan', 1) === undefined);
  } finally {
    await home.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
