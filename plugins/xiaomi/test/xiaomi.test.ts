import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Home } from '@livynq/core';
import { percentToLevel } from '@livynq/sdk';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import plugin from '../src/index.ts';
import { encSignature, encryptParams, rc4Decrypt, rc4Encrypt, signedNonce } from '../src/cloud.ts';
import { commandToWrites, planFeatures, valuesToUpdates } from '../src/mapping.ts';
import { MiioDevice, decodePacket, encodePacket } from '../src/miio.ts';
import type { DeviceSpec } from '../src/spec.ts';

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

const P = (iid: number, name: string, format: string, extra: Record<string, unknown> = {}) => ({ iid, type: `urn:miot-spec-v2:property:${name}:00000001:test:1`, format, access: ['read', 'write', 'notify'], ...extra });
const S = (iid: number, name: string, properties: unknown[], description = name) => ({ iid, type: `urn:miot-spec-v2:service:${name}:00007801:test:1`, description, properties });

const SPECS: Record<string, DeviceSpec> = {
  'yeelink.light.color1': {
    type: 'urn:miot-spec-v2:device:light:0000A001:yeelink-color1:1',
    description: 'Light',
    services: [
      S(1, 'device-information', []),
      S(2, 'light', [P(1, 'on', 'bool'), P(2, 'brightness', 'uint8', { 'value-range': [1, 100, 1], unit: 'percentage' }), P(3, 'color-temperature', 'uint32', { 'value-range': [1700, 6500, 1], unit: 'kelvin' }), P(4, 'color', 'uint32', { 'value-range': [1, 16777215, 1] })]),
    ],
  } as DeviceSpec,
  'chuangmi.plug.v3': {
    type: 'urn:miot-spec-v2:device:outlet:0000A002:chuangmi-v3:1',
    description: 'Outlet',
    services: [S(2, 'switch', [P(1, 'on', 'bool')]), S(5, 'power-consumption', []), S(6, 'switch', [P(1, 'on', 'bool'), P(2, 'electric-power', 'float', { access: ['read'] })], 'USB')],
  } as DeviceSpec,
  'lumi.curtain.hagl05': {
    type: 'urn:miot-spec-v2:device:curtain:0000A00C:lumi-hagl05:1',
    services: [S(2, 'curtain', [P(2, 'motor-control', 'uint8', { 'value-list': [{ value: 0, description: 'Pause' }, { value: 1, description: 'Open' }, { value: 2, description: 'Close' }] }), P(3, 'current-position', 'uint8', { 'value-range': [0, 100, 1] }), P(7, 'target-position', 'uint8', { 'value-range': [0, 100, 1] })])],
  } as DeviceSpec,
  'xiaomi.aircondition.mc5': {
    type: 'urn:miot-spec-v2:device:air-conditioner:0000A004:xiaomi-mc5:1',
    services: [
      S(2, 'air-conditioner', [P(1, 'on', 'bool'), P(2, 'mode', 'uint8', { 'value-list': [{ value: 1, description: 'Cool' }, { value: 2, description: 'Dry' }, { value: 3, description: 'Fan' }, { value: 4, description: 'Heat' }] }), P(4, 'target-temperature', 'float', { 'value-range': [16, 31, 0.5] })]),
      S(3, 'environment', [P(7, 'temperature', 'float', { access: ['read'] })]),
    ],
  } as DeviceSpec,
  'zhimi.airpurifier.mb3': {
    type: 'urn:miot-spec-v2:device:air-purifier:0000A007:zhimi-mb3:1',
    services: [S(2, 'air-purifier', [P(2, 'on', 'bool'), P(4, 'fan-level', 'uint8', { 'value-list': [{ value: 1, description: 'Level1' }, { value: 2, description: 'Level2' }, { value: 3, description: 'Level3' }] }), P(5, 'mode', 'uint8', { 'value-list': [{ value: 0, description: 'Auto' }, { value: 1, description: 'Sleep' }, { value: 2, description: 'Favorite' }, { value: 3, description: 'None' }] })]), S(3, 'environment', [P(7, 'relative-humidity', 'uint8'), P(8, 'temperature', 'float')])],
  } as DeviceSpec,
};

test('MIoT spec → endpoints, values and commands', () => {
  const light = planFeatures(SPECS['yeelink.light.color1']!);
  assert.deepEqual(light.map((f) => [f.key, f.deviceType, f.capabilities]), [['light:2', 'light.extendedColor', ['onOff', 'levelControl', 'colorControl']]]);
  const lv = valuesToUpdates(light[0]!, new Map<string, unknown>([['2.1', true], ['2.2', 50], ['2.3', 2700]]));
  assert.deepEqual(lv.find((u) => u.capability === 'levelControl')?.attributes, { currentLevel: 128 });
  assert.equal(lv.find((u) => u.capability === 'colorControl')?.attributes.colorTemperatureMireds, 370);
  assert.deepEqual(commandToWrites(light[0]!, 'levelControl', 'moveToLevel', { level: 254 }, { on: false }), [{ siid: 2, piid: 1, value: true }, { siid: 2, piid: 2, value: 100 }]);
  assert.deepEqual(commandToWrites(light[0]!, 'colorControl', 'moveToHueAndSaturation', { hue: 0, saturation: 254 }, { on: true }), [{ siid: 2, piid: 4, value: 0xff0000 }]);

  const plug = planFeatures(SPECS['chuangmi.plug.v3']!);
  assert.deepEqual(plug.map((f) => [f.key, f.deviceType, f.name]), [['outlet:2', 'plug.onOff', 'switch'], ['outlet:6', 'plug.onOff', 'USB']]);
  assert.deepEqual(plug[1]!.capabilities, ['onOff', 'electricalPowerMeasurement']);

  const [curtain] = planFeatures(SPECS['lumi.curtain.hagl05']!);
  assert.deepEqual(commandToWrites(curtain!, 'windowCovering', 'stop', {}, { on: false }), [{ siid: 2, piid: 2, value: 0 }]);
  assert.deepEqual(commandToWrites(curtain!, 'windowCovering', 'goToPosition', { position: 40 }, { on: false }), [{ siid: 2, piid: 7, value: 40 }]);
  assert.equal(valuesToUpdates(curtain!, new Map([['2.2', 1], ['2.3', 20]]))[0]!.attributes.operationalStatus, 'opening');

  const [ac] = planFeatures(SPECS['xiaomi.aircondition.mc5']!);
  assert.equal(ac!.deviceType, 'climate.airConditioner');
  const t = valuesToUpdates(ac!, new Map<string, unknown>([['2.1', true], ['2.2', 2], ['2.4', 26], ['3.7', 27.3]]))[0]!.attributes;
  assert.deepEqual([t.systemMode, t.targetTemperature, t.localTemperature, t.supportedModes], ['dry', 26, 27.3, 'off,cool,heat,dry,fan_only']);
  assert.deepEqual(commandToWrites(ac!, 'thermostat', 'setSystemMode', { mode: 'heat' }, { on: false }), [{ siid: 2, piid: 1, value: true }, { siid: 2, piid: 2, value: 4 }]);
  assert.deepEqual(commandToWrites(ac!, 'thermostat', 'setTargetTemperature', { temperature: 22.3 }, { on: true }), [{ siid: 2, piid: 4, value: 22.5 }]);

  const purifier = planFeatures(SPECS['zhimi.airpurifier.mb3']!);
  assert.deepEqual(purifier.map((f) => f.kind), ['fan', 'temperature', 'humidity']);
  assert.deepEqual(commandToWrites(purifier[0]!, 'fanControl', 'setPercent', { percent: 50 }, { on: true }), [{ siid: 2, piid: 5, value: 2 }, { siid: 2, piid: 4, value: 2 }]);
  assert.equal(valuesToUpdates(purifier[0]!, new Map<string, unknown>([['2.2', true], ['2.5', 0], ['2.4', 1]])).find((u) => u.capability === 'fanControl')!.attributes.fanMode, 'auto');
});

test('cloud request crypto round-trips', () => {
  const ssecurity = Buffer.alloc(16, 7).toString('base64');
  const { fields, signedNonce: sn } = encryptParams(ssecurity, '/home/device_list', { data: '{"a":1}' });
  assert.equal(sn, signedNonce(ssecurity, fields._nonce!));
  assert.equal(rc4Decrypt(sn, fields.data!), '{"a":1}');
  const hash = rc4Decrypt(sn, fields.rc4_hash__!);
  assert.equal(hash, encSignature('/home/device_list', sn, [['data', '{"a":1}']]));
  assert.equal(rc4Decrypt(sn, rc4Encrypt(sn, '你好')), '你好');
});

/** A Mijia Wi-Fi device on UDP: hello, miIO.info, get/set_properties. */
function fakeDevice(token: string, model: string, initial: Record<string, unknown>) {
  const tok = Buffer.from(token, 'hex');
  const props = new Map(Object.entries(initial));
  const socket = createSocket('udp4');
  const deviceId = 0x0a0b0c0d;
  const t0 = Date.now();
  const calls: string[] = [];
  socket.on('message', (msg, rinfo) => {
    const stamp = Math.floor((Date.now() - t0) / 1000) + 1000;
    if (msg.readUInt16BE(2) === 32) {
      const hello = encodePacket(tok, deviceId, stamp, Buffer.alloc(0)).subarray(0, 32);
      hello.writeUInt16BE(32, 2);
      return socket.send(hello, rinfo.port, rinfo.address);
    }
    let decoded;
    try {
      decoded = decodePacket(tok, msg);
    } catch {
      return; // wrong token: real devices stay silent
    }
    const req = JSON.parse(decoded.payload!.toString()) as { id: number; method: string; params: { siid: number; piid: number; value?: unknown }[] };
    calls.push(req.method);
    let result: unknown;
    if (req.method === 'miIO.info') result = { model, mac: '11:22:33:44:55:66' };
    else if (req.method === 'get_properties') result = req.params.map((p) => (props.has(`${p.siid}.${p.piid}`) ? { ...p, code: 0, value: props.get(`${p.siid}.${p.piid}`) } : { ...p, code: -4003 }));
    else if (req.method === 'set_properties') result = req.params.map((p) => (props.set(`${p.siid}.${p.piid}`, p.value), { ...p, code: 0 }));
    socket.send(encodePacket(tok, deviceId, stamp, Buffer.from(JSON.stringify({ id: req.id, result }) + '\0')), rinfo.port, rinfo.address);
  });
  return {
    props,
    calls,
    listen: () => new Promise<number>((r) => socket.bind(0, '127.0.0.1', () => r(socket.address().port))),
    close: () => socket.close(),
  };
}

test('miIO: handshake, wrong token detected, properties', async () => {
  const token = 'a'.repeat(32);
  const dev = fakeDevice(token, 'yeelink.light.color1', { '2.1': false });
  const port = await dev.listen();
  const client = new MiioDevice({ host: `127.0.0.1:${port}`, token });
  try {
    assert.deepEqual(await client.call('miIO.info'), { model: 'yeelink.light.color1', mac: '11:22:33:44:55:66' });
    await client.call('set_properties', [{ did: 'x', siid: 2, piid: 1, value: true }]);
    assert.equal(dev.props.get('2.1'), true);
    const wrong = new MiioDevice({ host: `127.0.0.1:${port}`, token: 'b'.repeat(32), timeoutMs: 300 });
    await assert.rejects(wrong.call('miIO.info'), /timed out/);
    wrong.close();
  } finally {
    client.close();
    dev.close();
  }
});

/** Xiaomi account (QR long polling) + Mi Home API + miot-spec.org, all local. */
function fakeCloud(deviceList: unknown[]) {
  const ssecurity = Buffer.alloc(16, 3).toString('base64');
  let scanned = false;
  const cloudProps = new Map<string, unknown>([['blt.3.abc:2.1', 23.5]]);
  const writes: unknown[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', async () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (url.pathname === '/longPolling/loginUrl') return res.end(`&&&START&&&${JSON.stringify({ code: 0, qr: `${base}/qr.png`, loginUrl: 'https://account.xiaomi.com/longPolling/login?ticket=t', lp: `${base}/lp`, timeout: 300 })}`);
      if (url.pathname === '/lp') {
        await until(() => scanned, 10_000);
        return res.end(`&&&START&&&${JSON.stringify({ code: 0, ssecurity, userId: 42, location: `${base}/sts?d=1` })}`);
      }
      if (url.pathname === '/sts') {
        res.setHeader('set-cookie', ['serviceToken=svc-token; Path=/', 'userId=42']);
        res.statusCode = 302;
        return res.end();
      }
      if (url.pathname === '/instances') {
        return res.end(JSON.stringify({ instances: Object.keys(SPECS).map((model) => ({ model, type: SPECS[model]!.type, version: 1, status: 'released' })).concat([{ model: 'cleargrass.sensor_ht.dk1', type: 'urn:th', version: 1, status: 'released' }]) }));
      }
      if (url.pathname === '/instance') {
        const type = url.searchParams.get('type');
        if (type === 'urn:th') return res.end(JSON.stringify({ type: 'urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:x:1', services: [S(2, 'temperature-humidity-sensor', [P(1, 'temperature', 'float', { access: ['read'] })])] }));
        return res.end(JSON.stringify(Object.values(SPECS).find((s) => s.type === type)));
      }
      // Mi Home API: check the cookie + signature, decrypt, answer encrypted.
      const form = new URLSearchParams(raw);
      if (!/serviceToken=svc-token/.test(String(req.headers.cookie))) return ((res.statusCode = 401), res.end());
      const sn = signedNonce(ssecurity, form.get('_nonce')!);
      const enc = [...form].filter(([k]) => !['signature', 'ssecurity', '_nonce'].includes(k));
      assert.equal(form.get('signature'), encSignature(url.pathname, sn, enc), 'request signature');
      const data = JSON.parse(rc4Decrypt(sn, form.get('data')!)) as { params?: { did: string; siid: number; piid: number; value?: unknown }[] };
      let result: unknown;
      if (url.pathname === '/home/device_list') result = { list: deviceList };
      else if (url.pathname === '/miotspec/prop/get') result = data.params!.map((p) => ({ ...p, code: cloudProps.has(`${p.did}:${p.siid}.${p.piid}`) ? 0 : -1, value: cloudProps.get(`${p.did}:${p.siid}.${p.piid}`) }));
      else result = data.params!.map((p) => (writes.push(p), { ...p, code: 0 }));
      res.end(rc4Encrypt(sn, JSON.stringify({ code: 0, message: 'ok', result })));
    });
  });
  return {
    scan: () => (scanned = true),
    cloudProps,
    writes,
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => server.close(),
  };
}

test('Xiaomi plugin: QR sign-in, local control, cloud sub-device, manual add', async () => {
  const lampToken = '0123456789abcdef0123456789abcdef';
  const lamp = fakeDevice(lampToken, 'yeelink.light.color1', { '2.1': false, '2.2': 30, '2.3': 4000, '2.4': 255 });
  const lampPort = await lamp.listen();
  const plugToken = 'fedcba9876543210fedcba9876543210';
  const plug = fakeDevice(plugToken, 'chuangmi.plug.v3', { '2.1': true, '6.1': false, '6.2': 3.5 });
  const plugPort = await plug.listen();
  const cloud = fakeCloud([
    { did: '1001', name: 'Desk lamp', model: 'yeelink.light.color1', token: lampToken, localip: `127.0.0.1:${lampPort}`, isOnline: true },
    { did: 'blt.3.abc', name: 'Bedroom sensor', model: 'cleargrass.sensor_ht.dk1', isOnline: true, parent_id: '' },
  ]);
  const port = await cloud.listen();
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'livynq-xiaomi-'));
  const home = new Home({ dataDir: dir });
  home.useAdapter(new InProcessPluginAdapter('xiaomi', plugin, { accountBase: base, apiBase: base, specBase: base, cloud: true, pollSeconds: 5, lanTimeoutMs: 300 }));
  try {
    await home.start();
    const started = (await home.invokeAction('xiaomi', 'login', {}, 'test')) as { loginUrl: string };
    assert.match(started.loginUrl, /^https:\/\/account\.xiaomi\.com\//);
    assert.equal(((await home.invokeAction('xiaomi', 'loginStatus', {}, 'test')) as { state: string }).state, 'waiting');
    cloud.scan();
    await until(() => home.registry.getDevice('xiaomi:1001') !== undefined && home.registry.getDevice('xiaomi:blt.3.abc') !== undefined);
    assert.equal(((await home.invokeAction('xiaomi', 'loginStatus', {}, 'test')) as { state: string; signedIn: boolean }).signedIn, true);
    for (const f of ['account.json', 'devices.json']) assert.equal(statSync(join(dir, 'plugin-data', 'xiaomi', f)).mode & 0o077, 0, `${f} is owner-only`);

    // Wi-Fi lamp: local miIO
    const d = home.registry.requireDevice('xiaomi:1001');
    assert.equal(d.protocol, 'xiaomi');
    assert.equal(d.name, 'Desk lamp');
    const ep = d.endpoints[0]!.id;
    await until(() => home.registry.getAttribute(d.id, ep, 'onOff', 'onOff') === false);
    await home.command({ deviceId: d.id, endpointId: ep, capability: 'levelControl', command: 'moveToLevel', params: { level: 254 } }, 'test');
    assert.equal(lamp.props.get('2.1'), true);
    assert.equal(lamp.props.get('2.2'), 100);
    await until(() => home.registry.getAttribute(d.id, ep, 'levelControl', 'currentLevel') === 254);

    // Bluetooth sensor behind a gateway: cloud
    const s = home.registry.requireDevice('xiaomi:blt.3.abc');
    await until(() => home.registry.getAttribute(s.id, s.endpoints[0]!.id, 'temperatureMeasurement', 'measuredValue') === 23.5);
    const status = (await home.invokeAction('xiaomi', 'devices', {}, 'test')) as { did: string; mode: string; state: string }[];
    assert.deepEqual(status.map((x) => [x.did, x.mode, x.state]).sort(), [['1001', 'local', 'online'], ['blt.3.abc', 'cloud', 'online']]);

    // Manual add by IP + token (model read from the device)
    const added = (await home.invokeAction('xiaomi', 'add', { host: `127.0.0.1:${plugPort}`, token: plugToken, name: 'Kettle plug' }, 'test')) as { did: string; model: string };
    assert.equal(added.model, 'chuangmi.plug.v3');
    await until(() => home.registry.getDevice(`xiaomi:${added.did}`) !== undefined);
    const p = home.registry.requireDevice(`xiaomi:${added.did}`);
    assert.deepEqual(p.endpoints.map((e) => e.name), ['switch', 'USB']);
    await until(() => home.registry.getAttribute(p.id, p.endpoints[1]!.id, 'electricalPowerMeasurement', 'activePower') === 3.5);

    // The LAN loses the lamp: with the cloud allowed it continues through the cloud…
    cloud.cloudProps.set('1001:2.1', true);
    cloud.cloudProps.set('1001:2.2', 10);
    lamp.close();
    await until(() => home.registry.getAttribute(d.id, ep, 'levelControl', 'currentLevel') === percentToLevel(10), 25_000);
    const lampStatus = ((await home.invokeAction('xiaomi', 'devices', {}, 'test')) as { did: string; mode: string; state: string }[]).find((x) => x.did === '1001')!;
    assert.deepEqual([lampStatus.mode, lampStatus.state], ['cloud', 'online']);
    await home.command({ deviceId: d.id, endpointId: ep, capability: 'onOff', command: 'off' }, 'test');
    assert.deepEqual(cloud.writes.at(-1), { did: '1001', siid: 2, piid: 1, value: false });
    // …and is offline once the cloud has no values either.
    cloud.cloudProps.delete('1001:2.1');
    cloud.cloudProps.delete('1001:2.2');
    await until(() => home.registry.requireDevice(d.id).availability === 'offline', 25_000);

    // Without the cloud, the gateway sub-device has no way in.
    assert.deepEqual(await home.invokeAction('xiaomi', 'setCloud', { enabled: false }, 'test'), { cloud: false });
    await until(() => ((home.registry.getDevice('xiaomi:blt.3.abc') && true) as boolean));
    const after = (await home.invokeAction('xiaomi', 'devices', {}, 'test')) as { did: string; state: string }[];
    assert.equal(after.find((x) => x.did === 'blt.3.abc')?.state, 'unsupported');
  } finally {
    await home.stop();
    plug.close();
    cloud.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
