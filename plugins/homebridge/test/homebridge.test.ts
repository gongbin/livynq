import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Home } from '@livynq/core';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import { percentToLevel } from '@livynq/sdk';
import plugin, { validateConfig } from '../src/index.ts';
import { hap } from '../src/hap.ts';
import { commandToWrites, featureUpdates, planService } from '../src/mapping.ts';
import { planImport } from '../src/importer.ts';
import { PlatformAccessory, versionGreaterOrEqual } from '../src/api.ts';

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout: ${fn.toString().slice(0, 140)}`);
    await sleep(20);
  }
}

type Fake = { configured: string[]; sets: [string, unknown][]; motion?: (v: boolean) => void; launched: number; shutdown: number };
const fake = () => (globalThis as unknown as { __hbFake: Fake }).__hbFake;

/** A dynamic platform plugin written like real ones (CommonJS, api.hap, onGet/onSet and legacy callbacks). */
const DYNAMIC = String.raw`
'use strict';
const PLUGIN = 'homebridge-fake';
module.exports = (api) => { api.registerPlatform('FakePlatform', FakePlatform); };
class FakePlatform {
  constructor(log, config, api) {
    this.log = log; this.api = api; this.cached = [];
    globalThis.__hbFake = { configured: [], sets: [], launched: 0, shutdown: 0 };
    log.info('starting %s', config.name);
    api.on('didFinishLaunching', () => { globalThis.__hbFake.launched++; this.discover(); });
    api.on('shutdown', () => { globalThis.__hbFake.shutdown++; });
  }
  configureAccessory(acc) { globalThis.__hbFake.configured.push(acc.context.key); this.cached.push(acc); this.setup(acc); }
  discover() {
    const { Service, Characteristic, uuid } = this.api.hap;
    for (const [key, name] of [['lamp', 'Desk Lamp'], ['motion', 'Hall Motion'], ['outlet', 'Kettle'], ['thermo', 'Living Thermostat'], ['tv', 'TV']]) {
      const id = uuid.generate('fake:' + key);
      if (this.cached.some((a) => a.UUID === id)) continue;
      const acc = new this.api.platformAccessory(name, id);
      acc.context.key = key;
      acc.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, 'FakeCo').setCharacteristic(Characteristic.Model, key.toUpperCase());
      if (key === 'lamp') acc.addService(Service.Lightbulb, name).getCharacteristic(Characteristic.Brightness);
      if (key === 'motion') acc.addService(Service.MotionSensor, name);
      if (key === 'outlet') acc.addService(Service.Outlet, name);
      if (key === 'thermo') acc.addService(Service.Thermostat, name);
      if (key === 'tv') acc.addService(Service.Television, name);
      this.setup(acc);
      this.api.registerPlatformAccessories(PLUGIN, 'FakePlatform', [acc]);
    }
  }
  setup(acc) {
    const { Service, Characteristic } = this.api.hap;
    const sets = globalThis.__hbFake.sets;
    const key = acc.context.key;
    if (key === 'lamp') {
      const s = acc.getService(Service.Lightbulb);
      const st = { on: false, bri: 40 };
      s.getCharacteristic(Characteristic.On).onGet(() => st.on).onSet((v) => { st.on = v; sets.push(['lamp.on', v]); });
      s.getCharacteristic(Characteristic.Brightness).onGet(() => st.bri).onSet((v) => { st.bri = v; sets.push(['lamp.bri', v]); });
    }
    if (key === 'motion') {
      const s = acc.getService(Service.MotionSensor);
      globalThis.__hbFake.motion = (v) => s.updateCharacteristic(Characteristic.MotionDetected, v);
    }
    if (key === 'outlet') {
      let on = true;
      acc.getService(Service.Outlet).getCharacteristic(Characteristic.On)
        .on('get', (cb) => cb(null, on))
        .on('set', (v, cb) => { on = v; sets.push(['outlet', v]); cb(); });
    }
    if (key === 'thermo') {
      const s = acc.getService(Service.Thermostat);
      let mode = 2;
      s.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => 21.5);
      s.getCharacteristic(Characteristic.TargetTemperature).onGet(() => 23).onSet((v) => sets.push(['thermo.target', v]));
      s.getCharacteristic(Characteristic.TargetHeatingCoolingState).onGet(() => mode).onSet((v) => { mode = v; sets.push(['thermo.mode', v]); });
    }
  }
}
`;

/** A static accessory plugin (registerAccessory + getServices). */
const STATIC = String.raw`
'use strict';
module.exports = (api) => { api.registerAccessory('FakeStatic', FakeSwitch); };
class FakeSwitch {
  constructor(log, config, api) {
    const { Service, Characteristic } = api.hap;
    this.name = config.name;
    this.on = false;
    this.info = new Service.AccessoryInformation().setCharacteristic(Characteristic.Manufacturer, 'Acme').setCharacteristic(Characteristic.Model, 'S1');
    this.sw = new Service.Switch(this.name);
    this.sw.getCharacteristic(Characteristic.On).onGet(() => this.on).onSet((v) => { this.on = v; globalThis.__hbStatic = v; });
  }
  getServices() { return [this.info, this.sw]; }
}
`;

function writePlugin(root: string, name: string, code: string, extra: Record<string, unknown> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', keywords: ['homebridge-plugin'], engines: { homebridge: '^1.6.0 || ^2.0.0-beta.0' }, ...extra }));
  writeFileSync(join(dir, 'index.js'), code);
  return dir;
}

test('HAP services → Livynq endpoints and commands', () => {
  const light = new hap.Service.Lightbulb('Lamp');
  light.getCharacteristic(hap.Characteristic.Brightness).updateValue(50);
  light.getCharacteristic(hap.Characteristic.ColorTemperature).updateValue(300);
  light.getCharacteristic(hap.Characteristic.On).updateValue(true);
  const f = planService(light)!;
  assert.deepEqual([f.kind, f.deviceType, f.capabilities], ['light', 'light.colorTemperature', ['onOff', 'levelControl', 'colorControl']]);
  const u = featureUpdates(f);
  assert.equal(u.find((x) => x.capability === 'levelControl')!.attributes.currentLevel, percentToLevel(50));
  assert.equal(u.find((x) => x.capability === 'colorControl')!.attributes.colorTemperatureMireds, 300);
  assert.deepEqual(commandToWrites(f, 'colorControl', 'moveToColorTemperature', { colorTemperatureMireds: 900 }).map((w) => w.value), [500]);

  const hc = new hap.Service.HeaterCooler('AC');
  hc.getCharacteristic(hap.Characteristic.Active).updateValue(1);
  hc.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState).updateValue(2);
  hc.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).updateValue(24);
  const ac = planService(hc)!;
  assert.deepEqual(featureUpdates(ac)[0]!.attributes.systemMode, 'cool');
  assert.deepEqual(featureUpdates(ac)[0]!.attributes.targetTemperature, 24);
  assert.deepEqual(commandToWrites(ac, 'thermostat', 'setSystemMode', { mode: 'heat' }).map((w) => [w.characteristic.displayName, w.value]), [['Active', 1], ['Target Heater-Cooler State', 1]]);

  const garage = planService(new hap.Service.GarageDoorOpener('Garage'))!;
  assert.deepEqual(commandToWrites(garage, 'windowCovering', 'open', {}).map((w) => w.value), [0]);
  assert.equal(planService(new hap.Service.Television('TV')), undefined);
  assert.ok(versionGreaterOrEqual('1.6.0') && !versionGreaterOrEqual('2.0.0'));

  // Cache round trip keeps services, values and context
  const acc = new PlatformAccessory('Lamp', hap.uuid.generate('x'));
  acc.context.token = 'abc';
  acc.addService(hap.Service.Lightbulb, 'Lamp').updateCharacteristic(hap.Characteristic.On, true);
  const back = PlatformAccessory.deserialize(JSON.parse(JSON.stringify(PlatformAccessory.serialize(acc))));
  assert.equal(back.context.token, 'abc');
  assert.equal(back.getService(hap.Service.Lightbulb)!.getCharacteristic(hap.Characteristic.On).value, true);
});

test('Homebridge plugins run inside Livynq: dynamic + static, commands, pushes, cache across restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'livynq-hb-'));
  const dataDir = join(root, 'data');
  const plugins = join(root, 'plugins');
  const dynamicDir = writePlugin(plugins, 'homebridge-fake', DYNAMIC);
  const staticDir = writePlugin(plugins, 'homebridge-fake-static', STATIC);
  const storage = join(dataDir, 'plugin-data', 'homebridge');
  mkdirSync(storage, { recursive: true });
  writeFileSync(
    join(storage, 'config.json'),
    JSON.stringify({
      platforms: [{ platform: 'FakePlatform', name: 'Fake', _bridge: { username: '0E:00:00:00:00:01' } }],
      accessories: [{ accessory: 'homebridge-fake-static.FakeStatic', name: 'Hall Switch' }, { accessory: 'NotInstalled', name: 'Ghost' }],
    }),
  );
  const start = async () => {
    const home = new Home({ dataDir });
    home.useAdapter(new InProcessPluginAdapter('homebridge', plugin, { pluginPaths: [dynamicDir, staticDir], pollSeconds: 3600 }));
    await home.start();
    return home;
  };
  const uuid = (key: string) => hap.uuid.generate(`fake:${key}`);
  let home = await start();
  try {
    await until(() => home.registry.getDevice(`homebridge:${uuid('thermo')}`) !== undefined);
    assert.equal(fake().launched, 1);

    // Dimmable light with onGet / onSet
    const lamp = home.registry.requireDevice(`homebridge:${uuid('lamp')}`);
    assert.deepEqual([lamp.name, lamp.protocol, lamp.info.manufacturer, lamp.info.model, lamp.endpoints[0]!.deviceType], ['Desk Lamp', 'homebridge', 'FakeCo', 'LAMP', 'light.dimmable']);
    const lep = lamp.endpoints[0]!.id;
    await until(() => home.registry.getAttribute(lamp.id, lep, 'levelControl', 'currentLevel') === percentToLevel(40));
    await home.command({ deviceId: lamp.id, endpointId: lep, capability: 'levelControl', command: 'moveToLevel', params: { level: 254 } }, 'test');
    assert.deepEqual(fake().sets.slice(-2), [['lamp.on', true], ['lamp.bri', 100]]);
    assert.equal(home.registry.getAttribute(lamp.id, lep, 'onOff', 'onOff'), true);

    // Pushed values (updateCharacteristic) reach Livynq without polling
    const motion = home.registry.requireDevice(`homebridge:${uuid('motion')}`);
    fake().motion!(true);
    await until(() => home.registry.getAttribute(motion.id, motion.endpoints[0]!.id, 'occupancySensing', 'occupied') === true);

    // Legacy get/set callbacks
    const outlet = home.registry.requireDevice(`homebridge:${uuid('outlet')}`);
    const oep = outlet.endpoints[0]!.id;
    await until(() => home.registry.getAttribute(outlet.id, oep, 'onOff', 'onOff') === true);
    await home.command({ deviceId: outlet.id, endpointId: oep, capability: 'onOff', command: 'off' }, 'test');
    assert.deepEqual(fake().sets.at(-1), ['outlet', false]);
    assert.equal(home.registry.getAttribute(outlet.id, oep, 'onOff', 'onOff'), false);

    // Thermostat
    const thermo = home.registry.requireDevice(`homebridge:${uuid('thermo')}`);
    const tep = thermo.endpoints[0]!.id;
    await until(() => home.registry.getAttribute(thermo.id, tep, 'thermostat', 'systemMode') === 'cool' && home.registry.getAttribute(thermo.id, tep, 'thermostat', 'localTemperature') === 21.5);
    await home.command({ deviceId: thermo.id, endpointId: tep, capability: 'thermostat', command: 'setSystemMode', params: { mode: 'heat' } }, 'test');
    assert.deepEqual(fake().sets.at(-1), ['thermo.mode', 1]);

    // Static accessory (registerAccessory)
    const sw = home.registry.listDevices().find((d) => d.name === 'Hall Switch')!;
    assert.equal(sw.info.manufacturer, 'Acme');
    await home.command({ deviceId: sw.id, endpointId: sw.endpoints[0]!.id, capability: 'onOff', command: 'on' }, 'test');
    assert.equal((globalThis as unknown as { __hbStatic: boolean }).__hbStatic, true);

    // Reports: the TV is unsupported, the missing accessory plugin is an issue
    const report = (await home.invokeAction('homebridge', 'accessories', {}, 'test')) as { accessories: { name: string; state: string; unsupported: string[] }[]; issues: { message: string }[] };
    assert.deepEqual(report.accessories.find((a) => a.name === 'TV'), { ...report.accessories.find((a) => a.name === 'TV')!, state: 'unsupported', unsupported: ['Television'] });
    assert.equal(home.registry.getDevice(`homebridge:${uuid('tv')}`), undefined);
    assert.ok(report.issues.some((i) => /NotInstalled/.test(i.message)));
    const list = (await home.invokeAction('homebridge', 'plugins', {}, 'test')) as unknown[];
    assert.deepEqual(list, [], 'plugins loaded from pluginPaths are not "installed" ones');

    // Config validation
    await assert.rejects(Promise.resolve().then(() => home.invokeAction('homebridge', 'config', { accessories: [{ accessory: 'X' }] }, 'test')), /needs a "name"/);
    assert.throws(() => validateConfig({ platforms: [{ name: 'no type' }] }), /needs a "platform"/);
  } finally {
    await home.stop();
  }
  assert.equal(fake().shutdown, 1);
  const cacheFile = join(storage, 'accessories', 'cachedAccessories');
  assert.equal(statSync(cacheFile).mode & 0o077, 0, 'the cache is owner-only (plugins keep tokens in context)');
  assert.equal((JSON.parse(readFileSync(cacheFile, 'utf8')) as unknown[]).length, 5);

  // Restart: cached accessories go back through configureAccessory, nothing is registered twice.
  home = await start();
  try {
    await until(() => fake().launched === 1 && home.registry.getDevice(`homebridge:${uuid('lamp')}`) !== undefined);
    assert.deepEqual([...fake().configured].sort(), ['lamp', 'motion', 'outlet', 'thermo', 'tv']);
    const lamp = home.registry.requireDevice(`homebridge:${uuid('lamp')}`);
    await until(() => home.registry.getAttribute(lamp.id, lamp.endpoints[0]!.id, 'levelControl', 'currentLevel') === percentToLevel(40));
    assert.equal(home.registry.listDevices().filter((d) => d.protocol === 'homebridge').length, 5);
  } finally {
    await home.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('import plan from an existing Homebridge storage directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-hb-src-'));
  try {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        bridge: { name: 'Homebridge', username: '0E:11:22:33:44:55', port: 51826, pin: '031-45-154' },
        platforms: [
          { platform: 'config', name: 'Config', port: 8581 },
          { platform: 'FakePlatform', name: 'Fake', _bridge: { username: '0E:00:00:00:00:02' } },
          { name: 'broken' },
        ],
        accessories: [{ accessory: 'FakeStatic', name: 'Hall Switch' }],
        disabledPlugins: ['homebridge-old'],
      }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'homebridge-config-ui-x': '^4.60.0', 'homebridge-fake': '1.0.0', 'homebridge-old': '^2.0.0' } }));
    const fakeDir = writePlugin(join(dir, 'node_modules'), 'homebridge-fake', DYNAMIC);
    writeFileSync(join(fakeDir, 'config.schema.json'), JSON.stringify({ pluginAlias: 'FakePlatform', pluginType: 'platform' }));
    mkdirSync(join(dir, 'accessories'));
    writeFileSync(join(dir, 'accessories', 'cachedAccessories'), JSON.stringify([{ UUID: 'a' }, { UUID: 'b' }]));

    const plan = planImport(dir, { platforms: [], accessories: [{ accessory: 'FakeStatic', name: 'Hall Switch' }] });
    assert.deepEqual(
      plan.plugins.map((p) => [p.name, p.version, p.install]),
      [['homebridge-config-ui-x', '4.60.0', false], ['homebridge-fake', '1.0.0', true], ['homebridge-old', '2.0.0', false]],
    );
    assert.deepEqual(plan.platforms, [{ block: { platform: 'FakePlatform', name: 'Fake' }, plugin: 'homebridge-fake', note: 'child bridge settings dropped: Livynq runs every plugin in one isolated process' }]);
    assert.deepEqual(plan.accessories, [], 'blocks already in Livynq are not copied twice');
    assert.equal(plan.cachedAccessories, 2);
    assert.ok(plan.ignored.some((i) => /^bridge/.test(i)) && plan.ignored.some((i) => /Homebridge UI/.test(i)));
    assert.ok(plan.warnings.some((w) => /without a "platform"/.test(w)));
    assert.throws(() => planImport(join(dir, 'nope')), /config\.json not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
