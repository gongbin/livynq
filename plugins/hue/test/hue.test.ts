import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Home } from '@livynq/core';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import plugin from '../src/index.ts';
import { buttonEventToUpdate, commandToBody, planDevices, resourceToUpdates } from '../src/mapping.ts';
import type { HueResource } from '../src/clip.ts';

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}

const KEY = 'test-app-key';

function resources(): HueResource[] {
  const dev = (id: string, name: string, product: string, services: [string, string][]) => ({
    id,
    type: 'device',
    metadata: { name },
    product_data: { manufacturer_name: 'Signify Netherlands B.V.', product_name: product, model_id: 'X', software_version: '1.108.7' },
    services: services.map(([rid, rtype]) => ({ rid, rtype })),
  });
  const owner = (rid: string) => ({ owner: { rid, rtype: 'device' } });
  return [
    dev('d-bridge', 'Hue Bridge', 'Hue Bridge', [['b-1', 'bridge']]),
    { id: 'b-1', type: 'bridge', ...owner('d-bridge') },
    dev('d-lamp', 'Sofa lamp', 'Hue color lamp', [['l-1', 'light'], ['z-1', 'zigbee_connectivity']]),
    {
      id: 'l-1',
      type: 'light',
      ...owner('d-lamp'),
      on: { on: false },
      dimming: { brightness: 50 },
      color_temperature: { mirek: 366, mirek_valid: true, mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } },
      color: { xy: { x: 0.4573, y: 0.41 } },
    },
    { id: 'z-1', type: 'zigbee_connectivity', ...owner('d-lamp'), status: 'connected' },
    dev('d-motion', 'Hall sensor', 'Hue motion sensor', [['m-1', 'motion'], ['t-1', 'temperature'], ['ll-1', 'light_level'], ['p-1', 'device_power'], ['z-2', 'zigbee_connectivity']]),
    { id: 'm-1', type: 'motion', ...owner('d-motion'), motion: { motion: false } },
    { id: 't-1', type: 'temperature', ...owner('d-motion'), temperature: { temperature: 21.37 } },
    { id: 'll-1', type: 'light_level', ...owner('d-motion'), light: { light_level: 20001 } },
    { id: 'p-1', type: 'device_power', ...owner('d-motion'), power_state: { battery_level: 88 } },
    { id: 'z-2', type: 'zigbee_connectivity', ...owner('d-motion'), status: 'connected' },
    dev('d-dimmer', 'Dimmer', 'Hue dimmer switch', [['btn-1', 'button'], ['btn-2', 'button'], ['p-2', 'device_power']]),
    { id: 'btn-1', type: 'button', ...owner('d-dimmer'), metadata: { control_id: 1 }, button: { last_event: 'short_release' } },
    { id: 'btn-2', type: 'button', ...owner('d-dimmer'), metadata: { control_id: 2 } },
    { id: 'p-2', type: 'device_power', ...owner('d-dimmer'), power_state: { battery_level: 10 } },
  ] as HueResource[];
}

test('resources → devices, updates and commands', () => {
  const plans = planDevices(resources());
  assert.deepEqual(
    plans.map((p) => [p.id, p.name, p.services.map((s) => s.deviceType)]),
    [
      ['hue:d-lamp', 'Sofa lamp', ['light.extendedColor']],
      ['hue:d-motion', 'Hall sensor', ['binarySensor.occupancy', 'sensor.temperature', 'sensor.light', 'sensor.battery']],
      ['hue:d-dimmer', 'Dimmer', ['event.button', 'event.button', 'sensor.battery']],
    ],
  );
  assert.deepEqual(plans[2]!.services.map((s) => s.name), ['Button 1', 'Button 2', undefined]);
  const [light] = plans[0]!.services;
  const lightRes = resources().find((r) => r.id === 'l-1')!;
  const color = resourceToUpdates(light!, lightRes).find((u) => u.capability === 'colorControl')!;
  assert.equal(color.attributes.colorMode, 'ct');
  assert.equal(color.attributes.colorTemperatureMireds, 366);
  // An xy-only event while the light is in color mode
  const xy = resourceToUpdates(light!, { color: { xy: { x: 0.17, y: 0.7 } } }, { color_temperature: { mirek: null, mirek_valid: false } }).find((u) => u.capability === 'colorControl')!;
  assert.equal(xy.attributes.colorMode, 'hs');
  const lux = resourceToUpdates(plans[1]!.services[2]!, { light: { light_level: 20001 } })[0]!;
  assert.equal(lux.attributes.measuredValue, 100);
  assert.equal(buttonEventToUpdate({ button: { button_report: { event: 'long_press' } } })?.attributes.lastEvent, 'long');
  assert.equal(buttonEventToUpdate({ button: { button_report: { event: 'initial_press' } } }), undefined);
  assert.deepEqual(commandToBody('colorControl', 'moveToColorTemperature', { colorTemperatureMireds: 600 }, { on: true, mirek: { min: 153, max: 500 } }), { on: { on: true }, color_temperature: { mirek: 500 } });
  assert.deepEqual(commandToBody('levelControl', 'moveToLevel', { level: 254, transitionTime: 10 }, { on: false }), { on: { on: true }, dimming: { brightness: 100 }, dynamics: { duration: 1000 } });
  assert.deepEqual(commandToBody('onOff', 'toggle', {}, { on: true }), { on: { on: false } });
});

function fakeBridge() {
  let data = resources();
  let linkPressed = false;
  const streams = new Set<ServerResponse>();
  const puts: { path: string; body: Record<string, unknown> }[] = [];
  const send = (events: unknown[]) => {
    for (const s of streams) s.write(`id: 1:0\ndata: ${JSON.stringify(events)}\n\n`);
  };
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/0/config') return json(200, { name: 'Hue Bridge', bridgeid: '001788FFFE123456', modelid: 'BSB002' });
      if (req.method === 'POST' && req.url === '/api') {
        return json(200, linkPressed ? [{ success: { username: KEY, clientkey: 'ck' } }] : [{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
      }
      if (req.headers['hue-application-key'] !== KEY) return json(403, { errors: [{ description: 'unauthorized user' }] });
      if (req.method === 'GET' && req.url === '/clip/v2/resource') return json(200, { errors: [], data });
      if (req.method === 'GET' && req.url === '/eventstream/clip/v2') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': hi\n\n');
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      const m = /^\/clip\/v2\/resource\/light\/(.+)$/.exec(req.url ?? '');
      if (req.method === 'PUT' && m) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        puts.push({ path: req.url!, body });
        json(200, { errors: [], data: [{ rid: m[1], rtype: 'light' }] });
        return send([{ type: 'update', data: [{ id: m[1], type: 'light', ...body }] }]);
      }
      json(404, { errors: [{ description: 'not found' }] });
    });
  });
  return {
    puts,
    send,
    press: () => (linkPressed = true),
    setData: (d: HueResource[]) => (data = d),
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => {
      for (const s of streams) s.destroy();
      server.close();
    },
  };
}

test('Hue bridge: pairing, devices, events, commands, removal', async () => {
  const bridge = fakeBridge();
  const port = await bridge.listen();
  const host = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'livynq-hue-'));
  const home = new Home({ dataDir: dir });
  home.useAdapter(new InProcessPluginAdapter('hue', plugin, { discovery: false }));
  try {
    await home.start();
    assert.deepEqual(await home.invokeAction('hue', 'pair', { host }, 'test'), { paired: false, linkButton: true, bridgeId: '001788fffe123456', name: 'Hue Bridge' });
    bridge.press();
    assert.equal(((await home.invokeAction('hue', 'pair', { host }, 'test')) as { paired: boolean }).paired, true);
    assert.equal(statSync(join(dir, 'plugin-data', 'hue', 'bridges.json')).mode & 0o077, 0, 'the key is stored owner-only');

    await until(() => home.registry.getDevice('hue:d-dimmer') !== undefined);
    const lamp = home.registry.requireDevice('hue:d-lamp');
    assert.equal(lamp.protocol, 'hue');
    assert.equal(home.registry.getDevice('hue:d-bridge'), undefined);
    const ep = lamp.endpoints[0]!.id;
    assert.equal(home.registry.getAttribute(lamp.id, ep, 'onOff', 'onOff'), false);
    assert.equal(home.registry.getAttribute('hue:d-motion', home.registry.requireDevice('hue:d-motion').endpoints[1]!.id, 'temperatureMeasurement', 'measuredValue'), 21.4);
    const dimmer = home.registry.requireDevice('hue:d-dimmer');
    assert.equal(home.registry.getAttribute(dimmer.id, dimmer.endpoints[0]!.id, 'genericSwitch', 'lastEvent'), undefined, 'old presses are not replayed');

    const list = (await home.invokeAction('hue', 'bridges', {}, 'test')) as { state: string; devices: number }[];
    assert.deepEqual(list.map((b) => [b.state, b.devices]), [['online', 3]]);

    await home.command({ deviceId: lamp.id, endpointId: ep, capability: 'levelControl', command: 'moveToLevel', params: { level: 128 } }, 'test');
    assert.deepEqual(bridge.puts.at(-1), { path: '/clip/v2/resource/light/l-1', body: { on: { on: true }, dimming: { brightness: 50 } } });
    await until(() => home.registry.getAttribute(lamp.id, ep, 'onOff', 'onOff') === true);

    const motion = home.registry.requireDevice('hue:d-motion');
    bridge.send([{ type: 'update', data: [{ id: 'm-1', type: 'motion', motion: { motion: true, motion_report: { changed: 'x', motion: true } } }] }]);
    await until(() => home.registry.getAttribute(motion.id, motion.endpoints[0]!.id, 'occupancySensing', 'occupied') === true);
    bridge.send([{ type: 'update', data: [{ id: 'btn-2', type: 'button', button: { button_report: { updated: 'x', event: 'short_release' } } }] }]);
    await until(() => home.registry.getAttribute(dimmer.id, dimmer.endpoints[1]!.id, 'genericSwitch', 'lastEvent') === 'single');
    bridge.send([{ type: 'update', data: [{ id: 'z-1', type: 'zigbee_connectivity', status: 'connectivity_issue' }] }]);
    await until(() => home.registry.requireDevice(lamp.id).availability === 'offline');

    // A device deleted in the Hue app disappears here too.
    bridge.setData(resources().filter((r) => !['d-dimmer', 'btn-1', 'btn-2', 'p-2'].includes(r.id)));
    bridge.send([{ type: 'delete', data: [{ id: 'd-dimmer', type: 'device' }] }]);
    await until(() => home.registry.getDevice('hue:d-dimmer') === undefined);
  } finally {
    await home.stop();
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
