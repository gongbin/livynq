# @livynq/sdk

SDK for Livynq plugins: write a Livynq plugin against the unified capability model; the hub takes care of HomeKit, Matter, the web UI, automations and AI agents (MCP).

```sh
npm install @livynq/sdk
```

Plugins never deal with HomeKit, Matter, MCP or the UI: exposing devices there is the hub's job.

```ts
export default defineAdapter({
  async setup(ctx) {
    const lamp = await ctx.devices.upsert({ id: 'acme:1', name: 'Lamp', protocol: 'lan',
      endpoints: [{ id: 1, deviceType: DeviceTypes.OnOffLight.id, capabilities: ['onOff'] }] });
    lamp.handle(1, 'onOff', { on: () => api.on(), off: () => api.off(), toggle: () => api.toggle() });
    api.onChange((on) => lamp.update(1, 'onOff', { onOff: on }));
    lamp.setAvailability('online');
  },
});
```

See the [plugin guide](https://github.com/gongbin/livynq/blob/main/docs/plugins.md) and the official plugins in [plugins/](https://github.com/gongbin/livynq/tree/main/plugins) for complete examples.

License: Apache-2.0
