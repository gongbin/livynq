import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { Home } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';
import { createServer } from '../src/server.ts';
import { PushService, encryptPayload, loadVapid, vapidHeader } from '../src/push.ts';

/** A browser's side of a subscription: keys plus RFC 8291 decryption. */
function browser() {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') },
    decrypt(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), pub, asPublic]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const data = body.subarray(21 + idlen);
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(data.subarray(data.length - 16));
      const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
      assert.equal(plain.at(-1), 2, 'last-record delimiter');
      return plain.subarray(0, plain.length - 1).toString('utf8');
    },
  };
}

test('aes128gcm payload and VAPID signature', () => {
  const b = browser();
  const body = encryptPayload(Buffer.from('hello'), b.keys.p256dh, b.keys.auth);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(b.decrypt(body), 'hello');

  const vapid = loadVapid(':memory:');
  const header = vapidHeader(vapid, 'https://web.push.apple.com/abc', 'https://example.org', 1_700_000_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.ok(m);
  const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString()) as { aud: string; exp: number };
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);
  const raw = Buffer.from(m[4]!, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url')));
});

test('subscriptions, notify.notify from automations, approvals to admins, dead endpoints', async () => {
  const home = new Home({ dataDir: ':memory:' });
  home.useExtension(new AutomationEngine());
  const delivered: { endpoint: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
    delivered.push({ endpoint: url, headers: init.headers, body: init.body });
    return new Response(null, { status: url.includes('/gone') ? 410 : 201 });
  }) as unknown as typeof fetch;
  const push = new PushService(home, { fetch: fakeFetch });
  const app = await createServer(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent', push });
  await home.start();
  const admin = home.tokens.create('admin', 'admin').token;
  const reader = home.tokens.create('phone', 'read');
  const req = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  try {
    const info = (await req('GET', '/api/v1/push', reader.token)).json();
    assert.equal(info.publicKey, push.vapid.publicKey);
    assert.deepEqual(info.subscriptions, []);

    const adminPhone = browser();
    const readerPhone = browser();
    const gone = browser();
    assert.equal((await req('POST', '/api/v1/push/subscriptions', admin, { subscription: { endpoint: 'https://push.example/admin', keys: adminPhone.keys }, name: 'iPad' })).statusCode, 201);
    assert.equal((await req('POST', '/api/v1/push/subscriptions', reader.token, { subscription: { endpoint: 'https://push.example/reader', keys: readerPhone.keys }, name: 'iPhone' })).statusCode, 201);
    assert.equal((await req('POST', '/api/v1/push/subscriptions', reader.token, { subscription: { endpoint: 'https://push.example/gone', keys: gone.keys } })).statusCode, 201);
    assert.equal((await req('POST', '/api/v1/push/subscriptions', reader.token, { subscription: { endpoint: 'http://evil.example/x', keys: gone.keys } })).statusCode, 400);
    assert.deepEqual((await req('GET', '/api/v1/push', reader.token)).json().subscriptions.map((s: { name: string }) => s.name), ['iPhone', 'Browser']);

    // An automation with HA's per-phone spelling validates and sends to everyone.
    const saved = await req('POST', '/api/v1/automations', admin, {
      id: 'door-alert',
      alias: 'Door alert',
      triggers: [{ trigger: 'homeassistant', event: 'start' }],
      actions: [{ action: 'notify.mobile_app_iphone', data: { title: 'Front door', message: 'The door opened', data: { url: '/#/devices' } } }],
    });
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal((await req('POST', '/api/v1/automations/door-alert/trigger', admin)).statusCode, 200);
    for (let i = 0; i < 100 && delivered.length < 3; i++) await sleep(10);
    assert.deepEqual(delivered.map((d) => d.endpoint).sort(), ['https://push.example/admin', 'https://push.example/gone', 'https://push.example/reader']);
    const msg = JSON.parse(readerPhone.decrypt(delivered.find((d) => d.endpoint.endsWith('/reader'))!.body)) as { title: string; body: string; url: string };
    assert.deepEqual([msg.title, msg.body, msg.url], ['Front door', 'The door opened', '/#/devices']);
    assert.equal(delivered[0]!.headers['content-encoding'], 'aes128gcm');
    assert.match(delivered[0]!.headers.authorization!, /^vapid t=/);
    // 410 Gone: the subscription is dropped
    await sleep(20);
    assert.deepEqual(push.list().map((s) => s.endpoint).sort(), ['https://push.example/admin', 'https://push.example/reader']);

    // Approval requests only reach admin tokens.
    delivered.length = 0;
    home.notify({ message: 'agent:x wants to unlock the front door', kind: 'confirmation' }, 'test');
    for (let i = 0; i < 100 && delivered.length < 1; i++) await sleep(10);
    await sleep(20);
    assert.deepEqual(delivered.map((d) => d.endpoint), ['https://push.example/admin']);

    // Test message to the caller's own devices; a revoked token stops receiving.
    delivered.length = 0;
    assert.deepEqual((await req('POST', '/api/v1/push/test', reader.token)).json(), { sent: 1, failed: 0 });
    home.tokens.revoke(reader.info.id);
    delivered.length = 0;
    home.notify({ message: 'hi' }, 'test');
    await sleep(50);
    assert.deepEqual(delivered.map((d) => d.endpoint), ['https://push.example/admin']);

    assert.equal((await req('DELETE', '/api/v1/push/subscriptions', admin, { endpoint: 'https://push.example/admin' })).statusCode, 200);
    assert.equal((await req('POST', '/api/v1/notify', admin, { message: '' })).statusCode, 400);
  } finally {
    await app.close();
    await home.stop();
  }
});
