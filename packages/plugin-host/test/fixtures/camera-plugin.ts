import { defineAdapter, DeviceTypes } from '@livynq/sdk';

/** Test plugin: one camera whose stream source is handed to the hub; actions to drop / crash. */
export default defineAdapter({
  async setup(ctx) {
    const id = 'fixture:cam';
    const ep = await ctx.endpointId(id, 'main');
    await ctx.devices.upsert({ id, name: 'Fixture Camera', protocol: 'lan', endpoints: [{ id: ep, deviceType: DeviceTypes.Camera.id, capabilities: ['camera'] }] });
    ctx.media.register(id, ep, { url: 'rtsp://admin:s%3Acret@192.0.2.10:554/stream1', snapshotUrl: 'http://192.0.2.10/snap.jpg' });
    ctx.actions.register('unregister', 'Drop the stream source', () => ctx.media.unregister(id, ep));
    ctx.actions.register('crash', 'Exit the process', () => void setTimeout(() => process.exit(4), 5));
  },
});
