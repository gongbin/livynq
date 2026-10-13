import type { EventEmitter } from 'node:events';
import { DeviceTypes, type PluginContext, type PluginDevice } from '@livynq/sdk';
import { commandToZigbee, payloadToUpdates, planEndpoints, type EndpointPlan, type Expose } from './exposes.ts';

/** The parts of zigbee-herdsman and zigbee-herdsman-converters this bridge uses (injectable for tests). */
export interface ZhEndpoint {
  ID: number;
}
export interface ZhDevice {
  ieeeAddr: string;
  type: string;
  modelID?: string;
  manufacturerName?: string;
  interviewCompleted?: boolean;
  powerSource?: string;
  softwareBuildID?: string;
  endpoints: ZhEndpoint[];
  getEndpoint(id: number): ZhEndpoint | undefined;
}
export interface ZhController extends EventEmitter {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  permitJoin(seconds: number): Promise<void>;
  getDevices(): ZhDevice[];
  getDevicesByType(type: string): ZhDevice[];
}
interface FromZigbee {
  cluster: string | number;
  type: string | string[];
  convert(model: unknown, msg: unknown, publish: (p: Record<string, unknown>) => void, options: Record<string, unknown>, meta: unknown): unknown;
}
interface ToZigbee {
  key: string[];
  endpoints?: string[];
  convertSet?(entity: unknown, key: string, value: unknown, meta: unknown): Promise<{ state?: Record<string, unknown> } | void> | { state?: Record<string, unknown> } | void;
}
export interface Definition {
  model: string;
  vendor: string;
  description: string;
  exposes: Expose[] | ((device: unknown, options: unknown) => Expose[]);
  fromZigbee: FromZigbee[];
  toZigbee: ToZigbee[];
  endpoint?: (device: unknown) => Record<string, number>;
  configure?: (device: unknown, coordinatorEndpoint: unknown, definition: Definition) => Promise<void>;
}
export interface Converters {
  findByDevice(device: unknown): Promise<Definition | undefined>;
}

interface Bound {
  zh: ZhDevice;
  definition: Definition;
  plans: { plan: EndpointPlan; endpointId: number }[];
  device: PluginDevice;
  /** Merged converter output, like Zigbee2MQTT's device state (converters read it via meta.state). */
  state: Record<string, unknown>;
}

const PERMIT_JOIN_ID = 'zigbee:permit-join';

export class ZigbeeBridge {
  readonly #ctx: PluginContext;
  readonly #controller: ZhController;
  readonly #zhc: Converters;
  readonly #names: Record<string, string>;
  readonly #bound = new Map<string, Bound>();
  #permitTimer: NodeJS.Timeout | undefined;

  constructor(ctx: PluginContext, controller: ZhController, zhc: Converters, options: { friendlyNames?: Record<string, string> } = {}) {
    this.#ctx = ctx;
    this.#controller = controller;
    this.#zhc = zhc;
    this.#names = options.friendlyNames ?? {};
  }

  async start(): Promise<void> {
    const c = this.#controller;
    c.on('message', (m: MessagePayload) => void this.#onMessage(m).catch((err: Error) => this.#ctx.log.warn('failed to process Zigbee message', { error: err.message })));
    c.on('deviceInterview', (e: { status: string; device: ZhDevice }) => {
      if (e.status === 'successful') void this.#onInterviewed(e.device);
      else if (e.status === 'failed') this.#ctx.log.warn('device interview failed; try pairing it again', { ieee: e.device.ieeeAddr });
    });
    c.on('deviceJoined', (e: { device: ZhDevice }) => this.#ctx.log.info('device joined', { ieee: e.device.ieeeAddr }));
    c.on('deviceLeave', (e: { ieeeAddr: string }) => void this.#onLeave(e.ieeeAddr));
    c.on('deviceAnnounce', (e: { device: ZhDevice }) => this.#bound.get(e.device.ieeeAddr)?.device.setAvailability('online'));
    c.on('adapterDisconnected', () => {
      this.#ctx.log.error('Zigbee adapter disconnected');
      for (const b of this.#bound.values()) b.device.setAvailability('offline');
    });
    c.on('permitJoinChanged', (e: { permitted: boolean }) => this.#permitSwitch?.update(1, 'onOff', { onOff: e.permitted }));

    await c.start();
    await this.#createPermitJoinSwitch();
    for (const zh of c.getDevices()) {
      if (zh.type !== 'Coordinator' && zh.interviewCompleted) await this.#publish(zh);
    }
    this.#ctx.log.info(`Zigbee network up: ${this.#bound.size} devices`);
  }

  async stop(): Promise<void> {
    clearTimeout(this.#permitTimer);
    await this.#controller.stop();
  }

  #permitSwitch: PluginDevice | undefined;

  /** A switch that opens the network for pairing (254 s), usable from the UI, CLI, agents or Apple Home. */
  async #createPermitJoinSwitch(): Promise<void> {
    const sw = await this.#ctx.devices.upsert({
      id: PERMIT_JOIN_ID,
      name: 'Zigbee Pairing Mode',
      protocol: 'zigbee',
      info: { manufacturer: 'Livynq', model: 'Zigbee coordinator' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.OnOffSwitch.id, capabilities: ['onOff'] }],
    });
    this.#permitSwitch = sw;
    const set = async (on: boolean) => {
      await this.#controller.permitJoin(on ? 254 : 0);
      sw.update(1, 'onOff', { onOff: on });
      clearTimeout(this.#permitTimer);
      if (on) this.#permitTimer = setTimeout(() => sw.update(1, 'onOff', { onOff: false }), 254_000);
    };
    sw.handle(1, 'onOff', { on: () => set(true), off: () => set(false), toggle: () => set(!sw.get(1, 'onOff', 'onOff')) });
    sw.update(1, 'onOff', { onOff: false });
    sw.setAvailability('online');
  }

  async #onInterviewed(zh: ZhDevice): Promise<void> {
    const definition = await this.#zhc.findByDevice(zh);
    if (definition?.configure) {
      try {
        const coordinator = this.#controller.getDevicesByType('Coordinator')[0]?.getEndpoint(1);
        await definition.configure(zh, coordinator, definition);
      } catch (err) {
        this.#ctx.log.warn('device configure failed (reporting may be limited)', { ieee: zh.ieeeAddr, error: (err as Error).message });
      }
    }
    await this.#publish(zh);
  }

  async #publish(zh: ZhDevice): Promise<void> {
    const definition = await this.#zhc.findByDevice(zh);
    if (!definition) {
      this.#ctx.log.warn('unsupported Zigbee device (not in zigbee-herdsman-converters)', { ieee: zh.ieeeAddr, model: zh.modelID, manufacturer: zh.manufacturerName });
      return;
    }
    const exposes = typeof definition.exposes === 'function' ? definition.exposes(zh, {}) : definition.exposes;
    const planned = planEndpoints(exposes, definition.description);
    if (!planned.length) {
      this.#ctx.log.info('device has no capabilities Livynq supports yet', { ieee: zh.ieeeAddr, model: definition.model });
      return;
    }
    const id = `zigbee:${zh.ieeeAddr}`;
    const plans = [];
    for (const plan of planned) plans.push({ plan, endpointId: await this.#ctx.endpointId(id, plan.key) });
    const device = await this.#ctx.devices.upsert({
      id,
      name: this.#names[zh.ieeeAddr] ?? `${definition.vendor} ${definition.model}`,
      protocol: 'zigbee',
      info: { manufacturer: definition.vendor, model: definition.model, serial: zh.ieeeAddr, firmware: zh.softwareBuildID },
      endpoints: plans.map(({ plan, endpointId }) => ({ id: endpointId, deviceType: plan.deviceType, capabilities: plan.capabilities, ...(plan.name ? { name: plan.name } : {}) })),
    });
    const bound: Bound = { zh, definition, plans, device, state: this.#bound.get(zh.ieeeAddr)?.state ?? {} };
    this.#bound.set(zh.ieeeAddr, bound);
    for (const { plan, endpointId } of plans) {
      const controllable = plan.capabilities.filter((c) => c === 'onOff' || c === 'levelControl' || c === 'colorControl');
      for (const capability of controllable) {
        const commands = capability === 'onOff' ? ['on', 'off', 'toggle'] : capability === 'levelControl' ? ['moveToLevel'] : ['moveToColorTemperature', 'moveToHueAndSaturation'];
        device.handle(
          endpointId,
          capability,
          Object.fromEntries(commands.map((command) => [command, (params: Record<string, unknown>) => this.#send(bound, plan, endpointId, capability, command, params)])),
        );
      }
    }
    device.setAvailability('online');
  }

  async #send(b: Bound, plan: EndpointPlan, endpointId: number, capability: string, command: string, params: Record<string, unknown>): Promise<void> {
    const { key, value, transition } = commandToZigbee(plan, capability, command, params, { on: b.device.get(endpointId, 'onOff', 'onOff') === true });
    const converter = b.definition.toZigbee.find((c) => c.key.includes(key) && c.convertSet && (!c.endpoints || !plan.endpointName || c.endpoints.includes(plan.endpointName)));
    if (!converter?.convertSet) throw new Error(`${b.definition.model} has no converter for "${key}"`);
    const endpoints = b.definition.endpoint?.(b.zh);
    const endpointNumber = plan.endpointName ? endpoints?.[plan.endpointName] : undefined;
    const entity = (endpointNumber !== undefined ? b.zh.getEndpoint(endpointNumber) : undefined) ?? b.zh.endpoints[0];
    if (!entity) throw new Error('device has no endpoints');
    const message = { [key]: value, ...(transition !== undefined ? { transition } : {}) };
    const result = await converter.convertSet(entity, key, value, {
      message,
      device: b.zh,
      mapped: b.definition,
      options: transition !== undefined ? { transition } : {},
      state: b.state,
      endpoint_name: plan.endpointName,
      publish: () => {},
      deviceExposesChanged: () => {},
    });
    // Converters return the state they just set (unsuffixed); multi-endpoint properties carry an `_<endpoint>` suffix.
    if (result && typeof result === 'object' && result.state) this.#apply(b, suffixed(result.state, plan.endpointName));
  }

  async #onMessage(m: MessagePayload): Promise<void> {
    const b = this.#bound.get(m.device.ieeeAddr);
    if (!b) return;
    b.device.setAvailability('online');
    const payload: Record<string, unknown> = {};
    const publish = (p: Record<string, unknown>) => this.#apply(b, p);
    for (const fz of b.definition.fromZigbee) {
      const types = Array.isArray(fz.type) ? fz.type : [fz.type];
      if (fz.cluster !== m.cluster || !types.includes(m.type)) continue;
      try {
        const converted = await fz.convert(b.definition, m, publish, {}, { state: b.state, device: b.zh, deviceExposesChanged: () => {} });
        if (converted && typeof converted === 'object') Object.assign(payload, converted);
      } catch (err) {
        this.#ctx.log.debug('converter failed', { model: b.definition.model, cluster: String(m.cluster), error: (err as Error).message });
      }
    }
    if (Object.keys(payload).length) this.#apply(b, payload);
  }

  #apply(b: Bound, payload: Record<string, unknown>): void {
    Object.assign(b.state, payload);
    for (const { plan, endpointId } of b.plans) {
      for (const u of payloadToUpdates(plan, payload)) b.device.update(endpointId, u.capability, u.attributes);
    }
  }

  async #onLeave(ieeeAddr: string): Promise<void> {
    this.#bound.delete(ieeeAddr);
    await this.#ctx.devices.remove(`zigbee:${ieeeAddr}`);
    this.#ctx.log.info('device left the network', { ieee: ieeeAddr });
  }
}

interface MessagePayload {
  type: string;
  device: ZhDevice;
  endpoint: ZhEndpoint;
  cluster: string | number;
  data: unknown;
  linkquality: number;
  groupID: number;
  meta: unknown;
}

function suffixed(state: Record<string, unknown>, endpointName: string | undefined): Record<string, unknown> {
  if (!endpointName) return state;
  return Object.fromEntries(Object.entries(state).map(([k, v]) => [k.endsWith(`_${endpointName}`) ? k : `${k}_${endpointName}`, v]));
}
