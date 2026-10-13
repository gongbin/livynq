import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Home, LivynqError } from '@livynq/core';
import { createPluginAdapter, ProcessPluginAdapter, resolvePlugin } from '@livynq/plugin-host';

const FIXTURE = fileURLToPath(new URL('./fixtures/lamp-plugin.ts', import.meta.url));
const cmd = (home: Home, capability: string, command: string, params?: Record<string, unknown>) =>
  home.command({ deviceId: 'fixture:lamp', endpointId: 1, capability, command, params }, 'test');

async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

test('process plugin: devices, commands, errors and state flow over IPC', async () => {
  const home = new Home({ dataDir: ':memory:' });
  const plugin = new ProcessPluginAdapter({ id: 'fixture', module: FIXTURE });
  home.useAdapter(plugin);
  await home.start();
  await until(() => plugin.info().status === 'running');
  const device = home.registry.requireDevice('fixture:lamp');
  assert.equal(device.adapter, 'fixture');
  assert.equal(device.availability, 'online');

  await cmd(home, 'onOff', 'on');
  assert.equal(home.registry.getAttribute('fixture:lamp', 1, 'onOff', 'onOff'), true);
  await cmd(home, 'onOff', 'toggle');
  await until(() => home.registry.getAttribute('fixture:lamp', 1, 'onOff', 'onOff') === false);
  await assert.rejects(cmd(home, 'levelControl', 'moveToLevel', { level: 254 }), (e: LivynqError) => /too bright/.test(e.message));
  assert.ok(plugin.info().pid);
  await home.stop();
  assert.equal(plugin.info().status, 'stopped');
});

test('supervisor restarts a crashed plugin, then disables it after repeated crashes', async () => {
  const home = new Home({ dataDir: ':memory:' });
  const plugin = new ProcessPluginAdapter({ id: 'crashy', module: FIXTURE, config: { crashOnToggle: true }, backoffMs: [50], maxCrashes: 3 });
  home.useAdapter(plugin);
  await home.start();
  await until(() => plugin.info().status === 'running');

  await cmd(home, 'onOff', 'toggle');
  await until(() => home.registry.getDevice('fixture:lamp')?.availability === 'offline');
  await until(() => plugin.info().status === 'running' && home.registry.getDevice('fixture:lamp')?.availability === 'online');
  assert.equal(plugin.info().restarts, 1);
  assert.equal(home.registry.getAttribute('fixture:lamp', 1, 'onOff', 'onOff'), true, 'state survives a restart');

  for (let i = 0; i < 2; i++) {
    await until(() => plugin.info().status === 'running');
    await cmd(home, 'onOff', 'toggle');
    await until(() => plugin.info().status !== 'running');
  }
  await until(() => plugin.info().status === 'disabled');
  await assert.rejects(cmd(home, 'onOff', 'on'), (e: LivynqError) => e.code === 'DEVICE_OFFLINE');

  await plugin.restart();
  assert.equal(plugin.info().status, 'running', 'manual restart re-enables it');
  await home.stop();
});

test('a plugin that fails during setup reports why and ends up disabled', async () => {
  const home = new Home({ dataDir: ':memory:' });
  const plugin = new ProcessPluginAdapter({ id: 'broken', module: FIXTURE, config: { failSetup: true }, backoffMs: [20], maxCrashes: 2 });
  home.useAdapter(plugin);
  await home.start();
  await until(() => plugin.info().status === 'disabled');
  assert.match(plugin.info().lastError!, /setup exploded/);
  await home.stop();
});

test('official virtual plugin, in-process: config-driven switches with persisted state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-virtual-'));
  try {
    const config = { switches: [{ id: 'guest-mode', name: 'Guest Mode' }, { id: 'good-night', name: 'Good Night', momentary: true }] };
    const spec = resolvePlugin(
      { module: '@livynq/plugin-virtual', isolation: 'in-process', config },
      { dataDir: dir, configDir: dir, resolveBuiltin: (m) => fileURLToPath(import.meta.resolve(m)) },
    );
    assert.equal(spec.id, 'virtual');
    let home = new Home({ dataDir: dir });
    home.useAdapter(await createPluginAdapter(spec));
    await home.start();
    await home.command({ deviceId: 'virtual:guest-mode', endpointId: 1, capability: 'onOff', command: 'on' }, 'test');
    await home.command({ deviceId: 'virtual:good-night', endpointId: 1, capability: 'onOff', command: 'on' }, 'test');
    assert.equal(home.registry.getAttribute('virtual:good-night', 1, 'onOff', 'onOff'), true);
    await until(() => home.registry.getAttribute('virtual:good-night', 1, 'onOff', 'onOff') === false, 3000);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'plugin-data', 'virtual', 'state.json'), 'utf8')), { 'guest-mode': true });
    await home.stop();

    // Restart with one switch removed from the config
    home = new Home({ dataDir: dir });
    home.useAdapter(await createPluginAdapter({ ...spec, config: { switches: [config.switches[0]] } }));
    await home.start();
    assert.equal(home.registry.getAttribute('virtual:guest-mode', 1, 'onOff', 'onOff'), true);
    assert.equal(home.registry.getDevice('virtual:good-night'), undefined);
    await home.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
