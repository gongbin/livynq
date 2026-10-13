import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MockServer } from 'zwave-js/Testing';
import { Home } from '@livynq/core';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import plugin from '../src/index.ts';

/** The mock expects one serial frame per chunk; over TCP an ACK and the next request can arrive together. */
// serialOnData is private in the typings
const controller = (mock: unknown) => mock as { serialOnData(d: number | Uint8Array): Promise<void> };
const splitFrames = {
  async onHostData(mock: unknown, data: Uint8Array) {
    if (data.length <= 1) return false;
    for (let i = 0; i < data.length; ) {
      if (data[i] === 0x01) {
        const end = i + data[i + 1]! + 2;
        void controller(mock).serialOnData(data.subarray(i, end));
        i = end;
      } else void controller(mock).serialOnData(data[i++]!);
    }
    return true;
  },
};

async function until(fn: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(50);
  }
}

test('Z-Wave plugin interviews nodes on a (mock) controller and controls them', { timeout: 120_000 }, async () => {
  const port = 5900 + Math.floor(Math.random() * 500);
  const server = new MockServer({
    port,
    interface: '127.0.0.1',
    config: {
      controller: { behaviors: [splitFrames] },
      nodes: [
        { id: 2, capabilities: { genericDeviceClass: 0x10, specificDeviceClass: 0x01, commandClasses: [0x25] } },
        { id: 3, capabilities: { genericDeviceClass: 0x11, specificDeviceClass: 0x01, commandClasses: [0x26] } },
      ],
    },
  });
  await server.start();
  const dir = mkdtempSync(join(tmpdir(), 'livynq-zwave-'));
  const home = new Home({ dataDir: dir });
  home.useAdapter(new InProcessPluginAdapter('zwave', plugin, { port: `tcp://127.0.0.1:${port}` }));
  try {
    await home.start();
    const keys = join(dir, 'plugin-data', 'zwave', 'keys.json');
    assert.equal(Object.keys(JSON.parse(readFileSync(keys, 'utf8'))).length, 6);
    assert.equal(statSync(keys).mode & 0o777, 0o600);

    const ids = () => home.registry.listDevices().map((d) => d.id).filter((id) => id.startsWith('zwave:'));
    await until(() => ids().length === 2);
    const plug = home.registry.listDevices().find((d) => d.id.endsWith('-2'))!;
    const dimmer = home.registry.listDevices().find((d) => d.id.endsWith('-3'))!;
    assert.equal(plug.endpoints[0]!.deviceType, 'switch.onOff');
    assert.equal(dimmer.endpoints[0]!.deviceType, 'light.dimmable');

    await home.command({ deviceId: plug.id, endpointId: plug.endpoints[0]!.id, capability: 'onOff', command: 'on' }, 'test');
    await until(() => home.registry.getAttribute(plug.id, plug.endpoints[0]!.id, 'onOff', 'onOff') === true);
    await home.command({ deviceId: dimmer.id, endpointId: dimmer.endpoints[0]!.id, capability: 'levelControl', command: 'moveToLevel', params: { level: 128 } }, 'test');
    await until(() => home.registry.getAttribute(dimmer.id, dimmer.endpoints[0]!.id, 'levelControl', 'currentLevel') === 129);

    const status = (await home.invokeAction('zwave', 'status', {}, 'test')) as { inclusionState: string; nodes: number };
    assert.equal(status.inclusionState, 'idle');
    assert.equal(status.nodes, 2);
    assert.equal(((await home.invokeAction('zwave', 'include', {}, 'test')) as { started: boolean }).started, true);
    assert.equal(((await home.invokeAction('zwave', 'status', {}, 'test')) as { inclusionState: string }).inclusionState, 'including');
    await home.invokeAction('zwave', 'stop', {}, 'test');
    await assert.rejects(home.invokeAction('zwave', 'pin', { pin: '12345' }, 'test'), /No device is waiting/);
  } finally {
    await home.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
