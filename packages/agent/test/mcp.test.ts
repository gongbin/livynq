import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DemoAdapter, defaultRiskLimit, Home } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';
import { createLocalHomeApi, createMcpServer } from '@livynq/agent';
import type { TokenScope } from '@livynq/model';

async function connect(home: Home, scope: TokenScope) {
  const server = createMcpServer({ api: createLocalHomeApi(home), scope, riskLimit: defaultRiskLimit(scope), clientName: 'test-agent', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]!.text;
    return { isError: Boolean(result.isError), text, json: result.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}

async function demoHome() {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExtension(new AutomationEngine());
  await home.start();
  return home;
}

test('read-only scope lists read tools and returns compact summaries', async () => {
  const home = await demoHome();
  const { client, call } = await connect(home, 'read');
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(tools.sort(), ['get_automation', 'get_device', 'get_history', 'home_overview', 'list_automations', 'list_devices']);

  const overview = await call('home_overview');
  assert.equal(overview.json.deviceCount, 11);
  assert.deepEqual(overview.json.lightsOn, ['Living Room Ceiling (Living Room)']);

  const lights = await call('list_devices', { domain: 'light' });
  assert.equal(lights.json.length, 2);
  assert.equal(lights.json[0].endpoints[0].state.brightnessPercent, 71);

  const bedroom = await call('list_devices', { room: 'bedroom' });
  assert.deepEqual(bedroom.json.map((d: { name: string }) => d.name).sort(), ['Bedroom AC', 'Bedroom Climate', 'Bedroom Lamp', 'Bedside Button']);

  const device = await call('get_device', { target: 'sensor.bedroom_climate_humidity' });
  assert.equal(device.json.endpoints[1].state.humidityPercent, 48);
  assert.deepEqual(device.json.commands, [], 'read-only clients do not see commands');

  const denied = await call('control_device', { target: 'Bedroom Lamp', action: 'turn_on' });
  assert.equal(denied.isError, true);
  await home.stop();
});

test('control scope can act; exposure policy is enforced; commands are audited', async () => {
  const home = await demoHome();
  const { call } = await connect(home, 'control');

  const ok = await call('control_device', { target: 'light.bedroom_lamp', action: 'set_brightness', brightness: 50 });
  assert.equal(ok.isError, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(home.registry.getAttribute('demo:bedroom-lamp', 1, 'levelControl', 'currentLevel'), 128);
  assert.equal(home.recentCommands(1)[0]?.source, 'agent:test-agent');

  const bad = await call('control_device', { target: 'Front Door', action: 'turn_on' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /does not support onOff/);

  home.registry.updateDevice('demo:coffee-plug', { exposure: { agent: 'readOnly' } });
  const ro = await call('control_device', { target: 'Coffee Machine', action: 'turn_on' });
  assert.match(ro.text, /read-only for agents/);

  home.registry.updateDevice('demo:coffee-plug', { exposure: { agent: 'hidden' } });
  assert.equal((await call('get_device', { target: 'Coffee Machine' })).isError, true);
  assert.equal((await call('list_devices', { query: 'coffee' })).json.length, 0);

  const history = await call('get_history', { target: 'light.bedroom_lamp', attribute: 'levelControl.currentLevel', hours: 1 });
  assert.ok(history.json.points.length >= 2);
  await home.stop();
});

test('agents can propose automations as disabled drafts and read traces', async () => {
  const home = await demoHome();
  const { call } = await connect(home, 'control');
  const bad = await call('propose_automation', { automation: { alias: 'Bad', triggers: [{ trigger: 'zone' }], actions: [] } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /unsupported trigger "zone"/);

  const draft = { alias: 'Evening lamp', triggers: [{ trigger: 'time', at: '19:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.bedroom_lamp' } }] };
  const ok = await call('propose_automation', { automation: draft });
  assert.equal(ok.json.id, 'evening_lamp');
  const engine = home.extension<AutomationEngine>('automations')!;
  assert.equal(engine.get('evening_lamp').enabled, false);
  assert.equal(engine.get('evening_lamp').createdBy, 'agent:test-agent');
  assert.match((await call('propose_automation', { automation: draft })).text, /already exists/, 'cannot overwrite');

  await engine.waitForRun('evening_lamp', engine.trigger('evening_lamp')!);
  const detail = await call('get_automation', { id: 'evening_lamp' });
  assert.equal(detail.json.traces[0].state, 'finished');
  assert.equal((await call('list_automations')).json[0].enabled, false);
  await home.stop();
});

test('high-risk actions are queued for approval; thermostats map on/off to modes', async () => {
  const home = await demoHome();
  const { call } = await connect(home, 'control');
  const pending = await call('control_device', { target: 'Front Door Lock', action: 'unlock' });
  assert.equal(pending.json.ok, false);
  assert.equal(pending.json.summary, 'Unlock Front Door Lock (Door Lock)');
  assert.equal(home.registry.getAttribute('demo:front-lock', 1, 'doorLock', 'lockState'), 'locked');
  assert.equal((await call('get_confirmation', { id: pending.json.pending_confirmation })).json.status, 'pending');
  await home.confirmations.approve(pending.json.pending_confirmation, 'web:owner');
  assert.equal((await call('get_confirmation', { id: pending.json.pending_confirmation })).json.status, 'executed');
  assert.equal(home.registry.getAttribute('demo:front-lock', 1, 'doorLock', 'lockState'), 'unlocked');

  // Medium risk within a control token's default limit: runs directly.
  assert.equal((await call('control_device', { target: 'cover.living_room_curtain', action: 'set_position', position: 30 })).json.ok, true);
  assert.equal((await call('control_device', { target: 'Bedroom AC', action: 'turn_on' })).json.sent.params.mode, 'auto');
  assert.equal((await call('control_device', { target: 'Bedroom AC', action: 'set_temperature', temperature: 23 })).json.ok, true);
  const ac = await call('get_device', { target: 'Bedroom AC' });
  assert.equal(ac.json.endpoints[0].state.targetTemperatureCelsius, 23);
  assert.equal(ac.json.endpoints[0].state.mode, 'auto');
  await home.stop();
});
