import { DeviceTypes, type DeviceDefinition } from '@livynq/model';
import type { Adapter, AdapterContext, DeviceHandle } from '@livynq/core';

export const lampDef: DeviceDefinition = {
  id: 'test:lamp',
  name: 'Desk Lamp',
  protocol: 'virtual',
  suggestedRoom: 'Office',
  endpoints: [{ id: 1, deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] }],
};

/** Adapter whose devices are wired up by the test body. */
export class TestAdapter implements Adapter {
  readonly id: string;
  ctx!: AdapterContext;
  handles = new Map<string, DeviceHandle>();
  readonly #setup: (adapter: TestAdapter) => void;

  constructor(setup: (adapter: TestAdapter) => void = () => {}, id = 'test') {
    this.id = id;
    this.#setup = setup;
  }

  async start(ctx: AdapterContext) {
    this.ctx = ctx;
    this.#setup(this);
  }

  async stop() {}

  add(def: DeviceDefinition): DeviceHandle {
    const handle = this.ctx.upsertDevice(def);
    this.handles.set(def.id, handle);
    return handle;
  }
}
