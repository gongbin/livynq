import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { DemoAdapter, Home } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';
import { createServer } from '../src/server.ts';

async function setup() {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExtension(new AutomationEngine());
  const app = await createServer(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent' });
  await home.start();
  const admin = home.tokens.create('admin', 'admin').token;
  const reader = home.tokens.create('reader', 'read').token;
  const control = home.tokens.create('bot', 'control').token;
  const req = (method: string, url: string, token?: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { home, app, admin, reader, control, req };
}

test('auth and scopes', async () => {
  const { app, home, admin, reader, req } = await setup();
  assert.equal((await req('GET', '/api/v1/health')).statusCode, 200);
  assert.equal((await req('GET', '/api/v1/devices')).statusCode, 401);
  assert.equal((await req('GET', '/api/v1/devices', 'lvq_nope')).statusCode, 401);
  assert.equal((await req('GET', '/api/v1/devices', reader)).statusCode, 200);
  const forbidden = await req('POST', '/api/v1/devices/demo:bedroom-lamp/endpoints/1/commands', reader, { capability: 'onOff', command: 'on' });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, 'FORBIDDEN');
  assert.equal((await req('GET', '/api/v1/tokens', reader)).statusCode, 403);
  assert.equal((await req('GET', '/api/v1/tokens', admin)).statusCode, 200);
  await app.close();
  await home.stop();
});

test('devices, commands, rooms and errors', async () => {
  const { app, home, admin, req } = await setup();
  const list = (await req('GET', '/api/v1/devices?domain=light', admin)).json();
  assert.equal(list.length, 2);
  assert.equal(list[0].entities['1'], 'light.living_room_ceiling');

  const byEntity = (await req('GET', '/api/v1/devices/light.bedroom_lamp', admin)).json();
  assert.equal(byEntity.id, 'demo:bedroom-lamp');

  const cmd = await req('POST', '/api/v1/devices/demo:bedroom-lamp/endpoints/1/commands', admin, { capability: 'onOff', command: 'on' });
  assert.equal(cmd.statusCode, 200);
  assert.equal(home.registry.getAttribute('demo:bedroom-lamp', 1, 'onOff', 'onOff'), true);
  assert.equal(home.recentCommands(1)[0]?.source, 'api:admin');

  const invalid = await req('POST', '/api/v1/devices/demo:bedroom-lamp/endpoints/1/commands', admin, { capability: 'levelControl', command: 'moveToLevel', params: { level: 0 } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_PARAMS');
  assert.equal((await req('GET', '/api/v1/devices/zigbee:nope', admin)).statusCode, 404);

  const room = (await req('POST', '/api/v1/rooms', admin, { name: '书房' })).json();
  const patched = (await req('PATCH', '/api/v1/devices/demo:bedroom-lamp', admin, { name: '床头灯', roomId: room.id, aliases: ['night light'] })).json();
  assert.equal(patched.roomName, '书房');
  assert.equal(patched.entities['1'], 'light.bedroom_lamp', 'renaming keeps the entity id');
  assert.equal((await req('PATCH', '/api/v1/entities/light.bedroom_lamp', admin, { entityId: 'light.nightstand' })).statusCode, 200);
  assert.equal((await req('GET', '/api/v1/devices/light.nightstand', admin)).json().name, '床头灯');

  const history = (await req('GET', '/api/v1/devices/demo:bedroom-lamp/history?capability=onOff&attribute=onOff', admin)).json();
  assert.deepEqual(history.map((p: { value: boolean }) => p.value), [false, true]);

  const homekit = (await req('GET', '/api/v1/homekit', admin)).json();
  assert.deepEqual(homekit, { enabled: false, bridges: [] });
  await app.close();
  await home.stop();
});

test('MCP over Streamable HTTP honours the token scope', async () => {
  const { app, home, reader, req } = await setup();
  const rpc = (body: unknown) =>
    app.inject({ method: 'POST', url: '/mcp', payload: body as object, headers: { authorization: `Bearer ${reader}`, accept: 'application/json, text/event-stream' } });
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.statusCode, 200);
  assert.equal(init.json().result.serverInfo.name, 'livynq');
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(!tools.json().result.tools.some((t: { name: string }) => t.name === 'control_device'));
  assert.equal((await req('POST', '/mcp')).statusCode, 401);
  await app.close();
  await home.stop();
});

test('automations: YAML create, validate, scopes, proposals, trigger, traces, webhook', async () => {
  const { app, home, admin, reader, control, req } = await setup();
  const yaml = [
    'alias: Coffee by webhook',
    'triggers:',
    '  - trigger: webhook',
    '    webhook_id: morning-coffee-42',
    'actions:',
    '  - action: switch.turn_on',
    '    target: { entity_id: switch.coffee_machine }',
  ].join('\n');
  const invalid = (await req('POST', '/api/v1/automations/validate', reader, { alias: 'x', triggers: [], actions: [{ delay: 'later' }] })).json();
  assert.equal(invalid.ok, false);
  assert.equal((await req('POST', '/api/v1/automations', control, { yaml })).statusCode, 403, 'creating needs admin');
  const created = await req('POST', '/api/v1/automations', admin, { yaml });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().id, 'coffee_by_webhook');
  assert.equal((await req('POST', '/api/v1/automations', admin, { yaml })).statusCode, 409);

  const proposal = await req('POST', '/api/v1/automations/proposals', control, { alias: 'Draft', triggers: [{ trigger: 'time', at: '07:00' }], actions: [{ delay: 1 }] });
  assert.equal(proposal.json().enabled, false);
  assert.equal(proposal.json().createdBy, 'proposal:bot');

  const hook = await app.inject({ method: 'POST', url: '/api/webhook/morning-coffee-42', payload: { hello: 1 } });
  assert.equal(hook.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/webhook/unknown-id-0000' })).statusCode, 200, 'unknown ids look the same');
  const engine = home.extension<AutomationEngine>('automations')!;
  for (let i = 0; i < 100 && engine.traces('coffee_by_webhook')[0]?.state !== 'finished'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(home.registry.getAttribute('demo:coffee-plug', 1, 'onOff', 'onOff'), true);
  const traces = (await req('GET', '/api/v1/automations/coffee_by_webhook/traces', reader)).json();
  assert.equal(traces[0].trigger.vars.json.hello, 1);

  const trig = (await req('POST', '/api/v1/automations/coffee_by_webhook/trigger', control, {})).json();
  assert.equal(trig.started, true);
  assert.equal((await req('POST', '/api/v1/automations/coffee_by_webhook/disable', admin, {})).json().enabled, false);
  assert.equal((await req('DELETE', '/api/v1/automations/coffee_by_webhook', admin)).statusCode, 204);
  assert.equal((await req('GET', '/api/v1/automations/coffee_by_webhook', admin)).statusCode, 404);
  await app.close();
  await home.stop();
});

test('wall panel settings and background image are shared hub-wide', async () => {
  const { app, home, admin, reader, req } = await setup();
  assert.deepEqual((await req('GET', '/api/v1/ui/settings', reader)).json().wall, { background: null, cardOpacity: 0.72, backgroundBlur: 0, backgroundDim: 0.25 });
  assert.equal((await req('PATCH', '/api/v1/ui/settings', admin, { wall: { cardOpacity: 0.1 } })).statusCode, 400);
  assert.equal((await req('PATCH', '/api/v1/ui/settings', reader, { wall: { cardOpacity: 0.5 } })).statusCode, 403);
  assert.equal((await req('PATCH', '/api/v1/ui/settings', admin, { wall: { cardOpacity: 0.5, backgroundBlur: 8 } })).json().wall.cardOpacity, 0.5);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5a1a0d10000000049454e44ae426082', 'hex');
  const up = await app.inject({ method: 'PUT', url: '/api/v1/ui/wall-background', payload: png, headers: { authorization: `Bearer ${admin}`, 'content-type': 'image/png' } });
  assert.equal(up.statusCode, 200);
  const url = up.json().wall.background.url as string;
  assert.match(url, /^\/api\/v1\/ui\/wall-background\?v=\d+$/);
  const img = await app.inject({ method: 'GET', url: `${url}&token=${reader}` });
  assert.equal(img.headers['content-type'], 'image/png');
  assert.deepEqual(img.rawPayload, png);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/ui/wall-background', payload: 'x', headers: { authorization: `Bearer ${admin}`, 'content-type': 'text/plain' } })).statusCode, 400);
  assert.equal((await req('DELETE', '/api/v1/ui/wall-background', admin)).json().wall.background, null);
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/ui/wall-background?token=${reader}` })).statusCode, 404);
  await app.close();
  await home.stop();
});

test('onboarding: methods, enabling an official plugin at runtime, plugin actions', async () => {
  const { app, home, admin, reader, req } = await setup();
  const before = (await req('GET', '/api/v1/onboarding', reader)).json();
  assert.deepEqual(before.methods.map((m: { id: string; enabled: boolean }) => [m.id, m.enabled]), [
    ['matter', false], ['zigbee', false], ['zwave', false], ['esphome', false], ['shelly', false], ['homeassistant', false], ['virtual', false], ['mqtt', false],
  ]);
  assert.equal((await req('POST', '/api/v1/plugins', admin, { module: 'evil-package' })).statusCode, 400);
  const enabled = await req('POST', '/api/v1/plugins', admin, { module: '@livynq/plugin-virtual', config: { switches: [{ id: 'party', name: 'Party Mode' }] } });
  assert.equal(enabled.statusCode, 201);
  assert.equal(home.registry.getDevice('virtual:party')?.name, 'Party Mode', 'started without a restart');
  assert.equal((await req('POST', '/api/v1/plugins', admin, { module: '@livynq/plugin-virtual' })).statusCode, 409);
  assert.equal((await req('GET', '/api/v1/onboarding', reader)).json().methods.find((m: { id: string }) => m.id === 'virtual').enabled, true);
  assert.equal((await req('POST', '/api/v1/plugins/virtual/actions/nope', admin, {})).statusCode, 404);
  assert.equal(enabled.json().status, 'running');

  // Reconfigure (restart with new config), then disable.
  const patched = await req('PATCH', '/api/v1/plugins/virtual', admin, { config: { switches: [{ id: 'movie', name: 'Movie Mode' }] } });
  assert.equal(patched.statusCode, 200);
  assert.equal(home.registry.getDevice('virtual:movie')?.availability, 'online');
  assert.equal(home.registry.getDevice('virtual:party'), undefined, 'switches dropped from the config are removed by the plugin');
  assert.equal((await req('DELETE', '/api/v1/plugins/virtual', admin)).statusCode, 204);
  assert.equal(home.registry.getDevice('virtual:movie')?.availability, 'offline');
  assert.equal((await req('GET', '/api/v1/onboarding', reader)).json().methods.find((m: { id: string }) => m.id === 'virtual').status, 'off');
  assert.equal((await req('GET', '/api/v1/system/serial-ports', admin)).statusCode, 200);
  await app.close();
  await home.stop();
});

test('floor plan API: levels, outlines, placement, background, scene', async () => {
  const { app, home, admin, reader, req } = await setup();
  const level = (await req('POST', '/api/v1/levels', admin, { name: '一楼' })).json();
  const kitchen = home.registry.findRoom('Kitchen')!;
  assert.equal((await req('PATCH', `/api/v1/rooms/${kitchen.id}`, admin, { levelId: 'missing' })).statusCode, 404);
  assert.equal((await req('PATCH', `/api/v1/rooms/${kitchen.id}`, admin, { levelId: level.id, polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] })).statusCode, 200);
  const placed = (await req('PUT', '/api/v1/devices/demo:coffee-plug/placement', admin, { levelId: level.id, x: 1, y: 1, mount: 'wall' })).json();
  assert.equal(placed.roomId, kitchen.id);
  const plan = (await req('GET', '/api/v1/floorplan', reader)).json();
  assert.equal(plan.levels[0].name, '一楼');
  assert.deepEqual(plan.placements, [{ deviceId: 'demo:coffee-plug', placement: { levelId: level.id, x: 1, y: 1, mount: 'wall' } }]);
  assert.equal((await req('PUT', '/api/v1/devices/demo:coffee-plug/placement', reader, null)).statusCode, 403);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const bg = await app.inject({ method: 'PUT', url: `/api/v1/levels/${level.id}/background?widthMeters=14`, payload: svg, headers: { authorization: `Bearer ${admin}`, 'content-type': 'image/svg+xml' } });
  assert.equal(bg.json().background.widthMeters, 14);
  const img = await app.inject({ method: 'GET', url: `${bg.json().background.url}&token=${reader}` });
  assert.equal(img.headers['content-type'], 'image/svg+xml');

  assert.equal((await req('PUT', `/api/v1/levels/${level.id}/scene`, admin, { data: { nodes: {} } })).statusCode, 200);
  assert.deepEqual((await req('GET', `/api/v1/levels/${level.id}/scene`, reader)).json().data, { nodes: {} });
  assert.equal((await req('DELETE', `/api/v1/levels/${level.id}`, admin)).statusCode, 204);
  assert.equal(home.registry.requireDevice('demo:coffee-plug').placement, null);
  await app.close();
  await home.stop();
});
