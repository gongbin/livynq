import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { Home } from '@livynq/core';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import plugin from '../src/index.ts';
import { commandToRpc, eventToUpdate, planComponents, statusToUpdates } from '../src/mapping.ts';
import { digestAuth } from '../src/rpc.ts';

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

test('components → endpoints, status and commands', () => {
  const status = {
    'switch:0': { id: 0, output: true, apower: 12.5 },
    'switch:1': { id: 1, output: false },
    'input:0': { id: 0, state: null },
    'input:1': { id: 1, state: false },
    'temperature:0': { id: 0, tC: 21.46 },
    sys: { mac: 'X' },
    wifi: {},
  };
  const config = { 'switch:1': { name: 'Hall light', consumption_type: 'lights' }, 'input:0': { type: 'button' }, 'input:1': { type: 'switch' } };
  const plans = planComponents(status, config);
  assert.deepEqual(plans.map((p) => [p.key, p.deviceType]), [
    ['input:0', 'event.button'],
    ['switch:0', 'plug.onOff'],
    ['switch:1', 'light.onOff'],
    ['temperature:0', 'sensor.temperature'],
  ]);
  const sw = plans.find((p) => p.key === 'switch:0')!;
  assert.deepEqual(statusToUpdates(sw, status['switch:0']), [
    { capability: 'onOff', attributes: { onOff: true } },
    { capability: 'electricalPowerMeasurement', attributes: { activePower: 12.5 } },
  ]);
  assert.deepEqual(statusToUpdates(plans.at(-1)!, status['temperature:0']), [{ capability: 'temperatureMeasurement', attributes: { measuredValue: 21.5 } }]);
  const [cover] = planComponents({ 'cover:0': { state: 'closing', current_pos: 40 } });
  assert.deepEqual(statusToUpdates(cover!, { state: 'closing', current_pos: 40 }), [{ capability: 'windowCovering', attributes: { currentPosition: 40, operationalStatus: 'closing' } }]);
  assert.deepEqual(commandToRpc(cover!, 'windowCovering', 'goToPosition', { position: 70 }), { method: 'Cover.GoToPosition', params: { id: 0, pos: 70 } });
  const [light] = planComponents({ 'light:2': { output: true, brightness: 50 } });
  assert.deepEqual(commandToRpc(light!, 'levelControl', 'moveToLevel', { level: 254 }), { method: 'Light.Set', params: { id: 2, on: true, brightness: 100 } });
  assert.equal(eventToUpdate('double_push')?.attributes.lastEvent, 'double');
  assert.equal(eventToUpdate('triple_push'), undefined);
});

/** A Shelly Plus 1PM with authentication enabled. */
function fakeShelly(password: string) {
  const state = { output: false, apower: 0 };
  const sockets = new Set<WebSocket>();
  const calls: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/shelly') return res.end(JSON.stringify({ id: 'shellyplus1pm-aabbcc', mac: 'AABBCCDDEEFF', model: 'SNSW-001P16EU', gen: 2, app: 'Plus1PM' }));
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, path: '/rpc' });
  const challenge = { auth_type: 'digest', nonce: 1700000000, nc: 1, realm: 'shellyplus1pm-aabbcc', algorithm: 'SHA-256' };
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; src: string; method: string; params: Record<string, unknown>; auth?: { response: string; cnonce: number } };
      const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ id: msg.id, src: 'shellyplus1pm-aabbcc', dst: msg.src, ...body }));
      if (!msg.auth || msg.auth.response !== digestAuth(challenge, password, msg.auth.cnonce).response) {
        return reply({ error: { code: 401, message: JSON.stringify(challenge) } });
      }
      calls.push(msg.method);
      switch (msg.method) {
        case 'Shelly.GetDeviceInfo':
          return reply({ result: { id: 'shellyplus1pm-aabbcc', mac: 'AABBCCDDEEFF', model: 'SNSW-001P16EU', gen: 2, app: 'Plus1PM', ver: '1.4.4', name: 'Kettle' } });
        case 'Shelly.GetConfig':
          return reply({ result: { 'switch:0': { id: 0, name: null }, 'input:0': { id: 0, type: 'switch' }, sys: { device: { name: 'Kettle' } } } });
        case 'Shelly.GetStatus':
          return reply({ result: { 'switch:0': { id: 0, ...state }, 'input:0': { id: 0, state: false }, sys: {} } });
        case 'Switch.Set':
          state.output = Boolean(msg.params.on);
          reply({ result: { was_on: !state.output } });
          for (const s of sockets) s.send(JSON.stringify({ src: 'shellyplus1pm-aabbcc', dst: msg.src, method: 'NotifyStatus', params: { ts: 1, 'switch:0': { id: 0, output: state.output } } }));
          return;
        default:
          return reply({ error: { code: 404, message: `No handler for ${msg.method}` } });
      }
    });
  });
  return {
    calls,
    sockets,
    listen: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))),
    close: () => {
      for (const s of sockets) s.terminate();
      wss.close();
      server.close();
    },
  };
}

test('Shelly device over RPC: digest auth, state, notifications, commands', async () => {
  const shelly = fakeShelly('secret');
  const port = await shelly.listen();
  const dir = mkdtempSync(join(tmpdir(), 'livynq-shelly-'));
  const home = new Home({ dataDir: dir });
  home.useAdapter(new InProcessPluginAdapter('shelly', plugin, { discovery: false, password: 'secret' }));
  try {
    await home.start();
    await assert.rejects(home.invokeAction('shelly', 'add', { host: '127.0.0.1:1' }, 'test'), /No Shelly device/);
    await home.invokeAction('shelly', 'add', { host: `127.0.0.1:${port}` }, 'test');
    await until(() => home.registry.getDevice('shelly:aabbccddeeff') !== undefined);
    const dev = home.registry.requireDevice('shelly:aabbccddeeff');
    assert.equal(dev.name, 'Kettle');
    assert.equal(dev.endpoints.length, 1, 'the switch-mode input is not a separate endpoint');
    assert.equal(dev.endpoints[0]!.deviceType, 'plug.onOff');
    const ep = dev.endpoints[0]!.id;
    await until(() => home.registry.getAttribute(dev.id, ep, 'onOff', 'onOff') === false);

    await home.command({ deviceId: dev.id, endpointId: ep, capability: 'onOff', command: 'on' }, 'test');
    await until(() => home.registry.getAttribute(dev.id, ep, 'onOff', 'onOff') === true);
    assert.ok(shelly.calls.includes('Switch.Set'));

    // Connection loss → offline
    for (const s of shelly.sockets) s.terminate();
    await until(() => home.registry.requireDevice(dev.id).availability === 'offline');
  } finally {
    await home.stop();
    shelly.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
