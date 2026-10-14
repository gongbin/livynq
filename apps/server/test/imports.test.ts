import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pino from 'pino';
import { Home } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';
import { createServer } from '../src/server.ts';
import { writeHaBackup } from '../../../packages/importer-homeassistant/test/fixture.ts';

test('HA backup uploaded from the browser: plan, apply, history, revert', async () => {
  const home = new Home({ dataDir: ':memory:' });
  home.useExtension(new AutomationEngine());
  const app = await createServer(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent' });
  await home.start();
  const admin = home.tokens.create('admin', 'admin').token;
  const reader = home.tokens.create('reader', 'read').token;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const raw = (token: string, payload: Buffer) =>
    app.inject({ method: 'POST', url: '/api/v1/imports/uploads?name=Full%20backup.tar', payload, headers: { ...auth(token), 'content-type': 'application/octet-stream' } });
  try {
    const backup = readFileSync(writeHaBackup());
    assert.equal((await raw(reader, backup)).statusCode, 403);
    assert.equal((await raw(admin, Buffer.from('not a tar file at all'))).statusCode, 400);

    const up = await raw(admin, backup);
    assert.equal(up.statusCode, 201, up.body);
    const { upload, size } = up.json() as { upload: string; size: number };
    assert.equal(size, backup.length);

    const plan = await app.inject({ method: 'POST', url: '/api/v1/imports/homeassistant/plan', headers: auth(admin), payload: { upload } });
    assert.equal(plan.statusCode, 200, plan.body);
    assert.equal(plan.json().haVersion, '2026.9.3');
    assert.equal(plan.json().summary.rooms, 2);
    assert.equal(plan.json().source, 'upload: Full backup.tar');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/imports/homeassistant/plan', headers: auth(admin), payload: { upload: '../../etc/passwd' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/imports/homeassistant/plan', headers: auth(admin), payload: { upload: '00000000-0000-0000-0000-000000000000' } })).statusCode, 404);

    const applied = await app.inject({ method: 'POST', url: '/api/v1/imports/homeassistant/apply', headers: auth(admin), payload: { upload } });
    assert.equal(applied.statusCode, 200, applied.body);
    const id = applied.json().import.id as string;
    assert.ok(home.registry.listRooms().some((r) => r.name === 'Living Room'));

    const history = (await app.inject({ method: 'GET', url: '/api/v1/imports', headers: auth(admin) })).json() as { id: string; revertedAt: number | null }[];
    assert.deepEqual(history.map((h) => [h.id, h.revertedAt]), [[id, null]]);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/imports/${id}/revert`, headers: auth(admin) })).statusCode, 200);
    assert.ok(!home.registry.listRooms().some((r) => r.name === 'Living Room'));
  } finally {
    await app.close();
    await home.stop();
  }
});
