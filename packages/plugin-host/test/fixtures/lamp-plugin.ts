import { defineAdapter, DeviceTypes } from '@livynq/sdk';

/** Test plugin: one lamp; `toggle` crashes the process when config.crashOnToggle is set. */
export default defineAdapter({
  async setup(ctx) {
    if (ctx.config.failSetup) throw new Error('setup exploded');
    const id = 'fixture:lamp';
    const lamp = await ctx.devices.upsert({
      id,
      name: 'Fixture Lamp',
      protocol: 'lan',
      endpoints: [{ id: await ctx.endpointId(id, 'main'), deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] }],
    });
    const ep = await ctx.endpointId(id, 'main');
    lamp.handle(ep, 'onOff', {
      on: () => lamp.update(ep, 'onOff', { onOff: true }),
      off: () => lamp.update(ep, 'onOff', { onOff: false }),
      toggle: () => {
        if (ctx.config.crashOnToggle) setTimeout(() => process.exit(3), 5);
        lamp.update(ep, 'onOff', { onOff: !lamp.get(ep, 'onOff', 'onOff') });
      },
    });
    lamp.handle(ep, 'levelControl', {
      moveToLevel: (p) => {
        if (Number(p.level) > 250) throw new Error('too bright for this lamp');
        lamp.update(ep, 'levelControl', { currentLevel: Number(p.level) });
      },
    });
    if (lamp.get(ep, 'onOff', 'onOff') === undefined) lamp.update(ep, 'onOff', { onOff: false });
    lamp.setAvailability('online');
    ctx.log.info('fixture ready', { known: (await ctx.devices.known()).length });
  },
});
