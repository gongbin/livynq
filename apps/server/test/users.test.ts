import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { DemoAdapter, Home, hashPassword, verifyPassword, accessFor } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';
import { createToolbox, createLocalHomeApi, restrictHomeApi } from '@livynq/agent';
import { createServer } from '../src/server.ts';
import { LoginLimiter } from '../src/routes/users.ts';

async function setup() {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExtension(new AutomationEngine());
  const app = await createServer(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent' });
  await home.start();
  const cli = home.tokens.create('local-cli', 'admin').token;
  const req = (method: string, url: string, token?: string, payload?: unknown, remoteAddress = '127.0.0.1') =>
    app.inject({ method: method as 'GET', url, payload: payload as object, remoteAddress, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { home, app, cli, req };
}

test('password hashing', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
  assert.notEqual(await hashPassword('correct horse'), h, 'salted');
});

test('first run: owner setup only from the hub machine or with an admin token', async () => {
  const { app, home, cli, req } = await setup();
  try {
    assert.deepEqual((await req('GET', '/api/v1/auth/status', undefined, undefined, '192.168.1.20')).json(), { users: false, setupHere: false });
    assert.deepEqual((await req('GET', '/api/v1/auth/status')).json(), { users: false, setupHere: true });
    const owner = { username: 'ann', password: 'secret-pass', displayName: 'Ann' };
    // From the LAN without a token: refused.
    assert.equal((await req('POST', '/api/v1/auth/setup', undefined, owner, '192.168.1.20')).statusCode, 403);
    // With a read-only token: refused too.
    const reader = home.tokens.create('wall', 'read').token;
    assert.equal((await req('POST', '/api/v1/auth/setup', reader, owner, '192.168.1.20')).statusCode, 403);
    // With the admin link token, from anywhere.
    const created = await req('POST', '/api/v1/auth/setup', cli, owner, '192.168.1.20');
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().user.role, 'owner');
    assert.match(created.json().token, /^lvq_/);
    assert.equal((await req('POST', '/api/v1/auth/setup', cli, { ...owner, username: 'bob' })).statusCode, 409, 'only once');
    assert.equal((await req('GET', '/api/v1/auth/status', undefined, undefined, '192.168.1.20')).json().users, true);
  } finally {
    await app.close();
    await home.stop();
  }
});

test('login, rate limiting, sessions, logout, password change', async () => {
  const { app, home, cli, req } = await setup();
  try {
    await req('POST', '/api/v1/auth/setup', cli, { username: 'Ann', password: 'secret-pass' });
    const bad = await req('POST', '/api/v1/auth/login', undefined, { username: 'ann', password: 'nope-nope' }, '10.0.0.9');
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().error.message, 'Wrong user name or password');
    assert.equal((await req('POST', '/api/v1/auth/login', undefined, { username: 'nobody', password: 'nope-nope' }, '10.0.0.9')).json().error.message, 'Wrong user name or password', 'same message for unknown users');

    const login = await req('POST', '/api/v1/auth/login', undefined, { username: 'ANN', password: 'secret-pass' }, '10.0.0.9');
    assert.equal(login.statusCode, 200, 'user names are case-insensitive');
    const session = login.json().token as string;
    const me = (await req('GET', '/api/v1/auth/me', session)).json();
    assert.deepEqual([me.user.username, me.token.scope, me.token.kind, me.token.name, me.access.rooms], ['Ann', 'admin', 'session', 'Ann', null]);
    // Commands from a session are recorded under the person.
    await req('POST', '/api/v1/devices/demo:bedroom-lamp/endpoints/1/commands', session, { capability: 'onOff', command: 'on' });
    assert.equal(home.recentCommands(1)[0]!.source, 'web:Ann');

    // Five failures, then a lock-out with the generic message.
    for (let i = 0; i < 5; i++) await req('POST', '/api/v1/auth/login', undefined, { username: 'ann', password: 'wrong-pass' }, '10.0.0.7');
    const locked = await req('POST', '/api/v1/auth/login', undefined, { username: 'ann', password: 'secret-pass' }, '10.0.0.7');
    assert.equal(locked.statusCode, 429);
    // Another address is not affected.
    assert.equal((await req('POST', '/api/v1/auth/login', undefined, { username: 'ann', password: 'secret-pass' }, '10.0.0.8')).statusCode, 200);

    // Password change keeps this session, signs out the others.
    const other = (await req('POST', '/api/v1/auth/login', undefined, { username: 'ann', password: 'secret-pass' }, '10.0.0.11')).json().token;
    assert.equal((await req('POST', '/api/v1/auth/password', session, { current: 'wrong-pass', password: 'new-secret-1' })).statusCode, 403);
    assert.equal((await req('POST', '/api/v1/auth/password', session, { current: 'secret-pass', password: 'short' })).statusCode, 400);
    assert.equal((await req('POST', '/api/v1/auth/password', session, { current: 'secret-pass', password: 'new-secret-1' })).statusCode, 200);
    assert.equal((await req('GET', '/api/v1/auth/me', other)).statusCode, 401);
    assert.equal((await req('GET', '/api/v1/auth/me', session)).statusCode, 200);

    assert.equal((await req('POST', '/api/v1/auth/logout', session)).statusCode, 200);
    assert.equal((await req('GET', '/api/v1/auth/me', session)).statusCode, 401);
    // The pre-accounts CLI token keeps working.
    assert.equal((await req('GET', '/api/v1/auth/me', cli)).json().user, null);
  } finally {
    await app.close();
    await home.stop();
  }
});

test('sessions expire and slide; limiter backs off exponentially', async () => {
  const { app, home, cli, req } = await setup();
  try {
    await req('POST', '/api/v1/auth/setup', cli, { username: 'ann', password: 'secret-pass' });
    const ann = home.users.findByUsername('ann')!;
    // Unused past its expiry: rejected and deleted.
    const idle = home.tokens.create('s', 'admin', undefined, { userId: ann.id, kind: 'session', ttlMs: 30 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(home.tokens.verify(idle.token), undefined, 'expired sessions are rejected');
    assert.equal(home.tokens.get(idle.info.id), undefined, 'and deleted');
    // In use: the expiry slides forward to 30 days from now.
    const used = home.tokens.create('s', 'admin', undefined, { userId: ann.id, kind: 'session', ttlMs: 60_000 });
    assert.ok(home.tokens.verify(used.token)!.expiresAt! > Date.now() + 29 * 24 * 3600_000);
    // API tokens never expire.
    assert.equal(home.tokens.create('script', 'read').info.expiresAt, null);
  } finally {
    await app.close();
    await home.stop();
  }
  const l = new LoginLimiter();
  for (let i = 0; i < 4; i++) l.fail('k', 0);
  assert.equal(l.check('k', 0), 0);
  l.fail('k', 0);
  assert.equal(l.check('k', 0), 30);
  l.fail('k', 0);
  assert.equal(l.check('k', 0), 60);
  l.succeed('k');
  assert.equal(l.check('k', 0), 0);
});

test('roles, owner invariants and guest room restrictions everywhere', async () => {
  const { app, home, cli, req } = await setup();
  try {
    const owner = (await req('POST', '/api/v1/auth/setup', cli, { username: 'ann', password: 'secret-pass' })).json().token as string;
    const rooms = (await req('GET', '/api/v1/rooms', owner)).json() as { id: string; name: string }[];
    const bedroom = rooms.find((r) => r.name === 'Bedroom')!.id;
    const login = async (username: string) => (await req('POST', '/api/v1/auth/login', undefined, { username, password: 'secret-pass' })).json().token as string;

    // Owner adds an admin, a member and a guest limited to the bedroom.
    for (const [username, role, extra] of [['bob', 'admin', {}], ['cat', 'member', {}], ['gus', 'guest', { allowedRooms: [bedroom] }]] as const) {
      const r = await req('POST', '/api/v1/users', owner, { username, password: 'secret-pass', role, ...extra });
      assert.equal(r.statusCode, 201, r.body);
    }
    const bob = await login('bob');
    const cat = await login('cat');
    const gus = await login('gus');
    const users = (await req('GET', '/api/v1/users', owner)).json() as { id: string; username: string; role: string }[];
    const id = (u: string) => users.find((x) => x.username === u)!.id;

    // Role → scope
    assert.deepEqual(
      await Promise.all([owner, bob, cat, gus].map(async (t) => (await req('GET', '/api/v1/auth/me', t)).json().token.scope)),
      ['admin', 'admin', 'control', 'control'],
    );
    assert.equal((await req('GET', '/api/v1/users', cat)).statusCode, 403);
    // Admins manage members/guests, not other admins; nobody can demote, disable or delete the owner.
    assert.equal((await req('POST', '/api/v1/users', bob, { username: 'dan', password: 'secret-pass', role: 'admin' })).statusCode, 403);
    assert.equal((await req('PATCH', `/api/v1/users/${id('cat')}`, bob, { displayName: 'Cat' })).statusCode, 200);
    assert.equal((await req('PATCH', `/api/v1/users/${id('ann')}`, bob, { role: 'member' })).statusCode, 403);
    assert.equal((await req('PATCH', `/api/v1/users/${id('ann')}`, cli, { disabled: true })).statusCode, 403);
    assert.equal((await req('DELETE', `/api/v1/users/${id('ann')}`, cli)).statusCode, 403);
    assert.equal((await req('POST', '/api/v1/users', owner, { username: 'eve', password: 'secret-pass', role: 'owner' })).statusCode, 403);

    // Guest: only bedroom devices, everywhere.
    const devices = (await req('GET', '/api/v1/devices', gus)).json() as { id: string; roomId: string }[];
    assert.ok(devices.length > 0 && devices.every((d) => d.roomId === bedroom));
    assert.equal((await req('GET', '/api/v1/devices/demo:living-ceiling', gus)).statusCode, 404);
    assert.equal((await req('GET', '/api/v1/devices/demo:living-ceiling/history?capability=onOff&attribute=onOff', gus)).statusCode, 404);
    assert.equal((await req('POST', '/api/v1/devices/demo:living-ceiling/endpoints/1/commands', gus, { capability: 'onOff', command: 'on' })).statusCode, 404);
    assert.equal((await req('POST', '/api/v1/devices/demo:bedroom-lamp/endpoints/1/commands', gus, { capability: 'onOff', command: 'on' })).statusCode, 200);
    assert.deepEqual((await req('GET', '/api/v1/rooms', gus)).json().map((r: { id: string }) => r.id), [bedroom]);
    const plan = (await req('GET', '/api/v1/floorplan', gus)).json();
    assert.deepEqual(plan.rooms.map((r: { id: string }) => r.id), [bedroom]);
    assert.equal((await req('GET', '/api/v1/entities', gus)).json().every((e: { deviceId: string }) => devices.some((d) => d.id === e.deviceId)), true);
    assert.equal((await req('GET', '/api/v1/automations', gus)).statusCode, 403, 'guests do not see automations');
    assert.equal((await req('GET', '/api/v1/automations', cat)).statusCode, 200, 'members do');
    assert.equal((await req('GET', '/api/v1/homekit', gus)).statusCode, 403, 'no pairing codes for restricted accounts');
    assert.equal((await req('GET', '/api/v1/cameras/demo:living-ceiling/1/snapshot.jpg', gus)).statusCode, 404);
    assert.equal((await req('POST', '/api/v1/tokens', gus, { name: 'x' })).statusCode, 403);

    // Guests never queue approvals: over their (low) limit is a plain refusal.
    home.registry.updateDevice('demo:front-lock', { roomId: bedroom });
    const unlock = await req('POST', '/api/v1/devices/demo:front-lock/endpoints/1/commands', gus, { capability: 'doorLock', command: 'unlock' });
    assert.equal(unlock.statusCode, 403);
    assert.equal(home.confirmations.list('pending').length, 0);
    // A member's unlock waits for an admin; members can't approve it.
    const pending = (await req('POST', '/api/v1/devices/demo:front-lock/endpoints/1/commands', cat, { capability: 'doorLock', command: 'unlock' })).json();
    assert.equal(pending.pending, true);
    assert.equal((await req('POST', `/api/v1/confirmations/${pending.confirmation.id}/approve`, cat)).statusCode, 403);
    assert.equal((await req('POST', `/api/v1/confirmations/${pending.confirmation.id}/approve`, bob)).json().decidedBy, 'web:bob');

    // MCP / assistant tools see the same restricted home.
    const gusAccess = accessFor(home.tokens.verify(gus)!, home.users)!;
    const tools = createToolbox({ api: restrictHomeApi(createLocalHomeApi(home), gusAccess), scope: gusAccess.scope, riskLimit: gusAccess.riskLimit, clientName: 'assistant/gus', version: 'test' });
    const listed = JSON.parse((await tools.call('list_devices', {})).content.map((c) => ('text' in c ? c.text : '')).join('')) as { id?: string; name: string }[];
    assert.ok(listed.length > 0 && listed.every((d) => !/Living Room/.test(d.name)));
    assert.equal((await tools.call('get_device', { target: 'light.living_room_ceiling' })).isError, true);
    assert.equal((await tools.call('control_device', { target: 'light.living_room_ceiling', action: 'turn_on' })).isError, true);
    assert.deepEqual(JSON.parse((await tools.call('list_automations', {})).content.map((c) => ('text' in c ? c.text : '')).join('')), []);

    // Tokens: members see only their own; guests' commands are audited under their name.
    const t = (await req('POST', '/api/v1/tokens', cat, { name: 'cat-script', scope: 'control' })).json();
    assert.equal(t.info.owner.username, 'cat');
    assert.equal((await req('POST', '/api/v1/tokens', cat, { name: 'x', scope: 'admin' })).statusCode, 403);
    assert.deepEqual((await req('GET', '/api/v1/tokens', cat)).json().map((x: { name: string }) => x.name), ['cat-script']);
    assert.ok((await req('GET', '/api/v1/tokens', owner)).json().length >= 2);

    // Ownership transfer; disabling signs out; deleting removes tokens.
    assert.equal((await req('POST', `/api/v1/users/${id('bob')}/transfer-ownership`, bob)).statusCode, 403);
    assert.equal((await req('POST', `/api/v1/users/${id('bob')}/transfer-ownership`, owner)).json().role, 'owner');
    assert.equal(home.users.get(id('ann'))!.role, 'admin');
    await req('PATCH', `/api/v1/users/${id('cat')}`, bob, { disabled: true });
    assert.equal((await req('GET', '/api/v1/auth/me', cat)).statusCode, 401);
    assert.equal((await req('POST', '/api/v1/auth/login', undefined, { username: 'cat', password: 'secret-pass' })).statusCode, 401);
    await req('DELETE', `/api/v1/users/${id('cat')}`, bob);
    assert.equal(home.tokens.list().some((x) => x.name === 'cat-script'), false);

    // Deleting the guest's only room leaves them with nothing, not everything.
    await req('DELETE', `/api/v1/rooms/${bedroom}`, bob);
    assert.deepEqual(home.users.get(id('gus'))!.allowedRooms, []);
    assert.deepEqual((await req('GET', '/api/v1/devices', gus)).json(), []);
  } finally {
    await app.close();
    await home.stop();
  }
});

test('WebSocket: a guest only receives their rooms', async () => {
  const { app, home, cli, req } = await setup();
  try {
    await req('POST', '/api/v1/auth/setup', cli, { username: 'ann', password: 'secret-pass' });
    const owner = (await req('POST', '/api/v1/auth/login', undefined, { username: 'ann', password: 'secret-pass' })).json().token;
    const bedroom = (await req('GET', '/api/v1/rooms', owner)).json().find((r: { name: string }) => r.name === 'Bedroom').id;
    await req('POST', '/api/v1/users', owner, { username: 'gus', password: 'secret-pass', role: 'guest', allowedRooms: [bedroom] });
    const gus = (await req('POST', '/api/v1/auth/login', undefined, { username: 'gus', password: 'secret-pass' })).json().token;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${gus}`);
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    for (let i = 0; i < 50 && !messages.length; i++) await new Promise((r) => setTimeout(r, 20));
    const snap = messages[0] as unknown as { devices: { roomId: string }[]; rooms: { id: string }[] };
    assert.ok(snap.devices.length > 0 && snap.devices.every((d) => d.roomId === bedroom));
    assert.deepEqual(snap.rooms.map((r) => r.id), [bedroom]);
    // State changes elsewhere are not sent; in the bedroom they are.
    await home.command({ deviceId: 'demo:living-ceiling', endpointId: 1, capability: 'onOff', command: 'toggle' }, 'test');
    await home.command({ deviceId: 'demo:bedroom-lamp', endpointId: 1, capability: 'onOff', command: 'toggle' }, 'test');
    await new Promise((r) => setTimeout(r, 100));
    const states = messages.filter((m) => m.type === 'state').map((m) => m.deviceId);
    assert.ok(states.includes('demo:bedroom-lamp'));
    assert.ok(!states.includes('demo:living-ceiling'));
    // Moving a device out of the bedroom removes it for the guest.
    home.registry.updateDevice('demo:bedroom-lamp', { roomId: null });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(messages.some((m) => m.type === 'device.removed' && m.id === 'demo:bedroom-lamp'));
    ws.close();
  } finally {
    await app.close();
    await home.stop();
  }
});
