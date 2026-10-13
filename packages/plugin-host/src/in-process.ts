import type { Adapter, AdapterContext, DeviceHandle } from '@livynq/core';
import type { PluginContext, PluginDefinition, PluginDevice } from '@livynq/sdk';

function wrap(handle: DeviceHandle): PluginDevice {
  return {
    id: handle.id,
    update: (ep, cap, attrs) => handle.update(ep, cap, attrs),
    get: (ep, cap, attr) => handle.get(ep, cap, attr),
    setAvailability: (a) => handle.setAvailability(a),
    handle: (ep, cap, handlers) => handle.handle(ep, cap, handlers),
  };
}

/** Runs a plugin inside the hub process (official plugins / low-memory mode). */
export class InProcessPluginAdapter implements Adapter {
  readonly id: string;
  readonly #definition: PluginDefinition;
  readonly #config: Record<string, unknown>;
  readonly #stopHooks: (() => void | Promise<void>)[] = [];

  constructor(id: string, definition: PluginDefinition, config: Record<string, unknown> = {}) {
    this.id = id;
    this.#definition = definition;
    this.#config = config;
  }

  async start(ctx: AdapterContext): Promise<void> {
    const pluginCtx: PluginContext = {
      pluginId: this.id,
      log: {
        debug: (m, d) => ctx.log.debug(d ?? {}, m),
        info: (m, d) => ctx.log.info(d ?? {}, m),
        warn: (m, d) => ctx.log.warn(d ?? {}, m),
        error: (m, d) => ctx.log.error(d ?? {}, m),
      },
      config: this.#config,
      dataDir: ctx.dataDir,
      devices: {
        upsert: async (def) => wrap(ctx.upsertDevice(def)),
        remove: async (id) => ctx.removeDevice(id),
        known: async () => ctx.knownDevices(),
      },
      endpointId: async (deviceId, key) => ctx.endpointId(deviceId, key),
      onStop: (fn) => void this.#stopHooks.push(fn),
    };
    await this.#definition.setup(pluginCtx);
  }

  async stop(): Promise<void> {
    for (const hook of this.#stopHooks.splice(0)) await hook();
  }
}
