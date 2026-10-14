import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeCamera } from '@livynq/media';
import { InProcessPluginAdapter } from '@livynq/plugin-host';
import { defineAdapter, DeviceTypes } from '@livynq/sdk';
import { DEMO_CLIP_H264, DEMO_SNAPSHOT_JPEG } from './camera-assets.ts';

/**
 * `livynq start --demo`: a living-room camera backed by a local fake RTSP server (looping a
 * synthetic clip) and a snapshot endpoint, so the camera UI has something real to play.
 */
export async function startDemoCamera(): Promise<{ adapter: InProcessPluginAdapter; close(): void }> {
  const camera = new FakeCamera({ codec: 'h264', annexB: Buffer.from(DEMO_CLIP_H264, 'base64'), fps: 10, username: 'demo', password: 'demo' });
  const rtspPort = await camera.listen(0, '127.0.0.1');
  const jpeg = Buffer.from(DEMO_SNAPSHOT_JPEG, 'base64');
  const snapshots: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length });
    res.end(jpeg);
  });
  await new Promise<void>((r) => snapshots.listen(0, '127.0.0.1', () => r()));
  const httpPort = (snapshots.address() as AddressInfo).port;
  const adapter = new InProcessPluginAdapter(
    'demo-camera',
    defineAdapter({
      async setup(ctx) {
        const id = 'demo:living-room-camera';
        const ep = await ctx.endpointId(id, 'main');
        const device = await ctx.devices.upsert({
          id,
          name: 'Living Room Camera',
          protocol: 'lan',
          suggestedRoom: 'Living Room',
          info: { manufacturer: 'Livynq', model: 'Demo Camera' },
          endpoints: [{ id: ep, deviceType: DeviceTypes.Camera.id, capabilities: ['camera'] }],
        });
        device.setAvailability('online');
        ctx.media.register(id, ep, { url: `rtsp://127.0.0.1:${rtspPort}/live`, username: 'demo', password: 'demo', snapshotUrl: `http://127.0.0.1:${httpPort}/snapshot.jpg` });
      },
    }),
  );
  return {
    adapter,
    close() {
      camera.close();
      snapshots.close();
    },
  };
}
