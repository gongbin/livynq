import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { Home } from '@livynq/core';
import { FakeCamera, boxes, digestResponse } from '@livynq/media';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import { defineAdapter, DeviceTypes } from '@livynq/sdk';
import { createServer } from '../src/server.ts';

const CLIP = readFileSync(new URL('../../../packages/media/test/fixtures/clip.h264', import.meta.url));

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(10);
  }
}

/** A snapshot endpoint behind Digest auth. */
function snapshotServer() {
  const nonce = 'abc123';
  const server = createHttp((req, res) => {
    const auth = req.headers.authorization ?? '';
    const response = /response="([^"]+)"/.exec(auth)?.[1];
    if (response !== digestResponse('admin', 'cam', 'secret', 'GET', '/snap.jpg', nonce)) {
      res.writeHead(401, { 'www-authenticate': `Digest realm="cam", nonce="${nonce}"` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
  return { listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))), close: () => server.close() };
}

test('camera live view over WebSocket and snapshots through the hub', async () => {
  const cam = new FakeCamera({ codec: 'h264', annexB: CLIP, fps: 30, username: 'admin', password: 'secret' });
  const rtspPort = await cam.listen();
  const snap = snapshotServer();
  const httpPort = await snap.listen();
  const plugin = defineAdapter({
    async setup(ctx) {
      for (const [id, withSnapshot] of [['test:cam', true], ['test:nosnap', false]] as const) {
        await ctx.devices.upsert({ id, name: id, protocol: 'lan', endpoints: [{ id: 1, deviceType: DeviceTypes.Camera.id, capabilities: ['camera'] }] });
        ctx.media.register(id, 1, { url: `rtsp://127.0.0.1:${rtspPort}/main`, username: 'admin', password: 'secret', ...(withSnapshot ? { snapshotUrl: `http://127.0.0.1:${httpPort}/snap.jpg` } : {}) });
      }
    },
  });
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new InProcessPluginAdapter('test', plugin));
  const app = await createServer(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent' });
  await home.start();
  const token = home.tokens.create('viewer', 'read').token;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    // Snapshot (Digest handled by the hub)
    const unauth = await fetch(`http://${base}/api/v1/cameras/test:cam/1/snapshot.jpg`);
    assert.equal(unauth.status, 401);
    const s = await fetch(`http://${base}/api/v1/cameras/test:cam/1/snapshot.jpg?token=${token}`);
    assert.equal(s.status, 200);
    assert.equal(s.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await s.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
    const none = await fetch(`http://${base}/api/v1/cameras/test:nosnap/1/snapshot.jpg?token=${token}`);
    assert.equal(none.status, 404);
    assert.match(((await none.json()) as { error: { message: string } }).error.message, /no snapshot URL/);
    assert.equal((await fetch(`http://${base}/api/v1/cameras/nope/1/snapshot.jpg?token=${token}`)).status, 404);

    // Live view
    const messages: (string | Uint8Array)[] = [];
    const ws = new WebSocket(`ws://${base}/api/v1/cameras/test:cam/1/live?token=${token}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => messages.push(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
    await until(() => messages.length >= 10);
    const init = JSON.parse(messages[0] as string);
    assert.deepEqual([init.type, init.mime, init.width, init.height, init.hasAudio], ['init', 'video/mp4; codecs="avc1.4D000D"', 320, 240, false]);
    assert.equal(boxes(messages[1] as Uint8Array)[0]!.type, 'ftyp');
    assert.equal(boxes(messages[2] as Uint8Array)[0]!.type, 'moof');
    await until(() => home.registry.getAttribute('test:cam', 1, 'camera', 'streaming') === true);
    assert.equal(home.registry.getAttribute('test:cam', 1, 'camera', 'codec'), 'h264');
    assert.equal(home.registry.getAttribute('test:cam', 1, 'camera', 'width'), 320);
    // Stream URLs and credentials are not in the device DTO.
    const dto = await (await fetch(`http://${base}/api/v1/devices/test:cam`, { headers: { authorization: `Bearer ${token}` } })).text();
    assert.ok(!dto.includes('secret') && !dto.includes('rtsp://'));
    ws.close();
  } finally {
    await app.close();
    await home.stop();
    cam.close();
    snap.close();
  }
});
