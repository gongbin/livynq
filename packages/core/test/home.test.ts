import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home, LivynqError, scopeAllows } from '@livynq/core';
import { DeviceTypes, type StateChange } from '@livynq/model';
import { lampDef, TestAdapter } from './helpers.ts';

function lampAdapter(options: { assumed?: boolean; report?: boolean } = {}) {
  return new TestAdapter((a) => {
    const h = a.add({ ...lampDef, endpoints: lampDef.endpoints.map((e) => ({ ...e, assumedState: options.assumed })) });
    h.setAvailability('online');
    h.update(1, 'onOff', { onOff: false });
    h.handle(1, 'onOff', {
      on: () => {
        if (options.report !== false) h.update(1, 'onOff', { onOff: true });
      },
      off: () => h.update(1, 'onOff', { onOff: false }),
      toggle: () => h.update(1, 'onOff', { onOff: !h.get(1, 'onOff', 'onOff') }),
    });
    h.handle(1, 'levelControl', { moveToLevel: () => new Promise(() => {}) });
  });
}

test('adapter devices get rooms, entities and state; commands route to handlers', async () => {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(lampAdapter());
  const changes: StateChange[] = [];
  home.bus.on('state', (c) => changes.push(c));
  await home.start();

  const device = home.registry.requireDevice('test:lamp');
  assert.equal(home.registry.getRoom(device.roomId!)?.name, 'Office');
  assert.deepEqual(home.registry.listEntities().map((e) => e.entityId), ['light.desk_lamp']);

  await home.command({ deviceId: 'test:lamp', endpointId: 1, capability: 'onOff', command: 'on' }, 'test');
  assert.equal(home.registry.getAttribute('test:lamp', 1, 'onOff', 'onOff'), true);
  assert.equal(changes.at(-1)?.source, 'adapter:test');
  assert.equal(home.recentCommands(1)[0]?.ok, true);
  await home.stop();
});

test('command validation errors are typed', async () => {
  const home = new Home({ dataDir: ':memory:', commandTimeoutMs: 50 });
  home.useAdapter(lampAdapter());
  await home.start();
  const cmd = (capability: string, command: string, params?: Record<string, unknown>) =>
    home.command({ deviceId: 'test:lamp', endpointId: 1, capability, command, params }, 'test');

  await assert.rejects(cmd('colorControl', 'moveToColorTemperature'), (e: LivynqError) => e.code === 'NOT_SUPPORTED');
  await assert.rejects(cmd('onOff', 'explode'), (e: LivynqError) => e.code === 'NOT_SUPPORTED');
  await assert.rejects(cmd('levelControl', 'moveToLevel', { level: 999 }), (e: LivynqError) => e.code === 'INVALID_PARAMS');
  await assert.rejects(cmd('levelControl', 'moveToLevel', { level: 10 }), (e: LivynqError) => e.code === 'TIMEOUT');
  home.registry.setAvailability('test:lamp', 'offline');
  await assert.rejects(cmd('onOff', 'on'), (e: LivynqError) => e.code === 'DEVICE_OFFLINE');
  assert.equal(home.recentCommands(10).filter((c) => !c.ok).length, 5);
  await home.stop();
});

test('assumed-state endpoints are updated optimistically', async () => {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(lampAdapter({ assumed: true, report: false }));
  await home.start();
  await home.command({ deviceId: 'test:lamp', endpointId: 1, capability: 'onOff', command: 'on' }, 'web');
  assert.equal(home.registry.getAttribute('test:lamp', 1, 'onOff', 'onOff'), true);
  await home.stop();
});

test('user edits, entity ids, endpoint ids and state survive restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-'));
  try {
    let home = new Home({ dataDir: dir });
    home.useAdapter(lampAdapter());
    await home.start();
    const epA = home.registry.endpointId('test:multi', 'unique-a');
    const epB = home.registry.endpointId('test:multi', 'unique-b');
    const room = home.registry.createRoom({ name: 'Study' });
    home.registry.updateDevice('test:lamp', { name: '台灯', roomId: room.id, aliases: ['desk light'] });
    await home.command({ deviceId: 'test:lamp', endpointId: 1, capability: 'onOff', command: 'on' }, 'test');
    await home.stop();

    home = new Home({ dataDir: dir });
    const before = home.registry.requireDevice('test:lamp');
    assert.equal(before.availability, 'unknown');
    assert.equal(home.registry.getAttribute('test:lamp', 1, 'onOff', 'onOff'), true);
    home.useAdapter(lampAdapter());
    await home.start();
    const after = home.registry.requireDevice('test:lamp');
    assert.equal(after.name, '台灯', 'adapter must not overwrite a user rename');
    assert.equal(after.roomId, room.id);
    assert.deepEqual(after.aliases, ['desk light']);
    assert.equal(home.registry.entityIdFor('test:lamp', 1), 'light.desk_lamp');
    assert.equal(home.registry.endpointId('test:multi', 'unique-b'), epB);
    assert.equal(home.registry.endpointId('test:multi', 'unique-a'), epA);
    assert.equal(home.registry.endpointId('test:multi', 'unique-c'), 3);
    assert.equal(home.resolveTarget('desk light').device.id, 'test:lamp');
    assert.equal(home.registry.history('test:lamp', 1, 'onOff', 'onOff', 0, Date.now()).length >= 2, true);
    await home.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTarget and findDevices', async () => {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(
    new TestAdapter((a) => {
      a.add(lampDef);
      a.add({
        id: 'test:climate',
        name: 'Office Climate',
        protocol: 'virtual',
        endpoints: [
          { id: 1, name: 'Temperature', deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] },
          { id: 2, name: 'Humidity', deviceType: DeviceTypes.HumiditySensor.id, capabilities: ['relativeHumidityMeasurement'] },
        ],
      });
    }),
  );
  await home.start();
  assert.equal(home.resolveTarget('sensor.office_climate_humidity').endpointId, 2);
  assert.equal(home.resolveTarget('test:climate', 'relativeHumidityMeasurement').endpointId, 2);
  assert.equal(home.resolveTarget('test:climate#2').entityId, 'sensor.office_climate_humidity');
  assert.throws(() => home.resolveTarget('nothing'), (e: LivynqError) => e.code === 'NOT_FOUND');
  assert.deepEqual(home.findDevices({ domain: 'light' }).map((d) => d.id), ['test:lamp']);
  assert.deepEqual(home.findDevices({ room: 'office' }).map((d) => d.id), ['test:lamp']);
  assert.deepEqual(home.findDevices({ text: 'humidity' }).map((d) => d.id), ['test:climate']);
  await home.stop();
});

test('device ownership and definition validation', async () => {
  const home = new Home({ dataDir: ':memory:' });
  const a = new TestAdapter((x) => x.add(lampDef), 'a');
  const b = new TestAdapter(() => {}, 'b');
  home.useAdapter(a).useAdapter(b);
  await home.start();
  assert.throws(() => b.add(lampDef), (e: LivynqError) => e.code === 'CONFLICT');
  assert.throws(() => b.add({ ...lampDef, id: 'bad id' }), (e: LivynqError) => e.code === 'INVALID_PARAMS');
  assert.throws(() => b.add({ ...lampDef, id: 'b:x', endpoints: [{ id: 1, deviceType: 'nope', capabilities: [] }] }), (e: LivynqError) => e.code === 'INVALID_PARAMS');
  await home.stop();
});

test('tokens store only hashes and check scopes', () => {
  const home = new Home({ dataDir: ':memory:' });
  const { token, info } = home.tokens.create('claude', 'read');
  assert.match(token, /^lvq_/);
  assert.equal(home.tokens.verify(token)?.id, info.id);
  assert.equal(home.tokens.verify('lvq_wrong'), undefined);
  assert.equal(JSON.stringify(home.storage.sql('SELECT * FROM tokens').all()).includes(token), false);
  assert.equal(scopeAllows('read', 'control'), false);
  assert.equal(scopeAllows('admin', 'control'), true);
  home.tokens.revoke(info.id);
  assert.equal(home.tokens.verify(token), undefined);
});
