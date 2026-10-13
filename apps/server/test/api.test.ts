import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { DemoAdapter, Home } from '@livynq/core';
import { createServer } from '../src/server.ts';

async function setup() {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new DemoAdapter({ simulateSensors: false }));
  const app = await createServer(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent' });
  await home.start();
  const admin = home.tokens.create('admin', 'admin').token;
  const reader = home.tokens.create('reader', 'read').token;
  const req = (method: string, url: string, token?: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { home, app, admin, reader, req };
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
