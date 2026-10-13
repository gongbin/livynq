import mqtt, { type MqttClient } from 'mqtt';
import {
  degreesToHue,
  hueToDegrees,
  levelToPercent,
  percentToLevel,
  percentToSat,
  satToPercent,
  type AttributeValue,
  type DeviceDefinition,
} from '@livynq/model';
import type { Adapter, AdapterContext, CommandHandler, DeviceHandle } from '@livynq/core';
import { hsToXy, xyToHs } from './color.ts';
import {
  SUPPORTED_COMPONENTS,
  deviceKey,
  lightColorModes,
  normalizeConfig,
  parseDiscoveryTopic,
  planEndpoint,
  type Component,
  type DiscoveryConfig,
  type EndpointPlan,
} from './discovery.ts';
import { compileTemplate, payloadEquals, UnsupportedTemplateError } from './template.ts';
import { wireExtended } from './components.ts';

export interface MqttAdapterOptions {
  url: string;
  username?: string;
  password?: string;
  /** Home Assistant discovery prefix. */
  discoveryPrefix?: string;
  clientId?: string;
  /** Wait for more discovery messages of the same device before publishing it (ms). */
  settleMs?: number;
}

interface EntityRecord {
  discoveryTopic: string;
  component: Component;
  config: DiscoveryConfig;
  plan: EndpointPlan;
  endpointId: number;
}

interface DeviceRecord {
  id: string;
  entities: Map<string, EntityRecord>;
  handle?: DeviceHandle;
  timer?: NodeJS.Timeout;
  /** Topic listeners currently installed for this device. */
  listeners: { topic: string; fn: (payload: string) => void }[];
  availability?: boolean;
}

/**
 * Consumes Home Assistant MQTT discovery, so Zigbee2MQTT, Tasmota, ESPHome (MQTT mode),
 * OpenMQTTGateway and DIY devices appear without configuration.
 */
export class MqttAdapter implements Adapter {
  readonly id = 'mqtt';
  readonly #options: Required<Pick<MqttAdapterOptions, 'discoveryPrefix' | 'settleMs'>> & MqttAdapterOptions;
  #ctx!: AdapterContext;
  #client: MqttClient | undefined;
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #entityDevice = new Map<string, string>();
  readonly #topicListeners = new Map<string, Set<(payload: string) => void>>();
  readonly #warned = new Set<string>();

  constructor(options: MqttAdapterOptions) {
    this.#options = { discoveryPrefix: 'homeassistant', settleMs: 300, ...options };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.#ctx = ctx;
    const client = mqtt.connect(this.#options.url, {
      username: this.#options.username,
      password: this.#options.password,
      clientId: this.#options.clientId ?? `livynq-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
    });
    this.#client = client;
    client.on('connect', () => {
      ctx.log.info({ url: this.#options.url }, 'MQTT connected');
      client.subscribe(`${this.#options.discoveryPrefix}/#`);
      for (const topic of this.#topicListeners.keys()) client.subscribe(topic);
      for (const device of this.#devices.values()) this.#refreshAvailability(device);
    });
    client.on('offline', () => {
      ctx.log.warn('MQTT broker unreachable');
      for (const device of this.#devices.values()) device.handle?.setAvailability('offline');
    });
    client.on('error', (err) => ctx.log.warn({ err: err.message }, 'MQTT error'));
    client.on('message', (topic, payload) => this.#onMessage(topic, payload.toString()));
  }

  async stop(): Promise<void> {
    for (const device of this.#devices.values()) clearTimeout(device.timer);
    await this.#client?.endAsync();
    this.#client = undefined;
  }

  // ---------------------------------------------------------------- discovery

  #onMessage(topic: string, payload: string): void {
    const parsed = parseDiscoveryTopic(this.#options.discoveryPrefix, topic);
    if (parsed) return this.#onDiscovery(topic, parsed, payload);
    const listeners = this.#topicListeners.get(topic);
    if (!listeners) return;
    for (const fn of listeners) {
      try {
        fn(payload);
      } catch (err) {
        this.#ctx.log.warn({ topic, err: (err as Error).message }, 'failed to process MQTT state');
      }
    }
  }

  #onDiscovery(topic: string, parsed: ReturnType<typeof parseDiscoveryTopic> & object, payload: string): void {
    if (!payload.trim()) return this.#removeEntity(topic);
    if (!SUPPORTED_COMPONENTS.includes(parsed.component as Component)) return;
    let config: DiscoveryConfig;
    try {
      config = normalizeConfig(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      return this.#warnOnce(topic, 'invalid discovery JSON');
    }
    const component = parsed.component as Component;
    const plan = planEndpoint(component, config);
    if (!plan) return this.#ctx.log.debug({ topic, deviceClass: config.device_class }, 'unsupported entity type, skipped');
    if (component === 'light' && config.schema && config.schema !== 'json' && config.schema !== 'default' && config.schema !== 'basic') {
      return this.#warnOnce(topic, `light schema "${String(config.schema)}" not supported`);
    }

    const deviceId = `mqtt:${deviceKey(config, parsed).replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
    const previousDevice = this.#entityDevice.get(topic);
    if (previousDevice && previousDevice !== deviceId) this.#removeEntity(topic);

    // All button triggers of a device share one "button" endpoint.
    const endpointKey = component === 'device_automation' ? 'device_automation' : (config.unique_id ?? topic);
    const endpointId = this.#ctx.endpointId(deviceId, endpointKey);
    let device = this.#devices.get(deviceId);
    if (!device) this.#devices.set(deviceId, (device = { id: deviceId, entities: new Map(), listeners: [] }));
    device.entities.set(topic, { discoveryTopic: topic, component, config, plan, endpointId });
    this.#entityDevice.set(topic, deviceId);
    this.#schedulePublish(device);
  }

  #removeEntity(topic: string): void {
    const deviceId = this.#entityDevice.get(topic);
    const device = deviceId ? this.#devices.get(deviceId) : undefined;
    if (!device) return;
    device.entities.delete(topic);
    this.#entityDevice.delete(topic);
    if (device.entities.size === 0) {
      clearTimeout(device.timer);
      this.#detach(device);
      this.#devices.delete(device.id);
      this.#ctx.removeDevice(device.id);
    } else {
      this.#schedulePublish(device);
    }
  }

  #schedulePublish(device: DeviceRecord): void {
    clearTimeout(device.timer);
    device.timer = setTimeout(() => this.#publish(device), this.#options.settleMs);
  }

  #publish(device: DeviceRecord): void {
    const entities = [...device.entities.values()].sort((a, b) => a.endpointId - b.endpointId);
    const meta = entities.find((e) => e.config.device)?.config.device ?? {};
    const single = new Set(entities.map((e) => e.endpointId)).size === 1;
    const def: DeviceDefinition = {
      id: device.id,
      name: meta.name ?? entityName(entities[0]!) ?? device.id.slice(5),
      protocol: 'mqtt',
      info: { manufacturer: meta.manufacturer, model: meta.model, firmware: meta.sw_version },
      suggestedRoom: meta.suggested_area,
      endpoints: entities
        .filter((e, i) => entities.findIndex((x) => x.endpointId === e.endpointId) === i)
        .map((e) => ({
          id: e.endpointId,
          deviceType: e.plan.deviceType,
          ...(single ? {} : { name: e.component === 'device_automation' ? 'Button' : (entityName(e) ?? e.config.device_class ?? e.component) }),
          capabilities: e.plan.capabilities,
          ...(e.config.state_topic || e.config.optimistic === false || ['device_automation', 'event'].includes(e.component) ? {} : { assumedState: true }),
        })),
    };
    let handle: DeviceHandle;
    try {
      handle = this.#ctx.upsertDevice(def);
    } catch (err) {
      return this.#warnOnce(device.id, (err as Error).message);
    }
    device.handle = handle;
    this.#detach(device);
    for (const entity of entities) {
      try {
        this.#wireEntity(device, handle, entity);
      } catch (err) {
        if (!(err instanceof UnsupportedTemplateError)) throw err;
        this.#warnOnce(entity.discoveryTopic, err.message);
      }
    }
    this.#wireAvailability(device);
    this.#refreshAvailability(device);
  }

  #listen(device: DeviceRecord, topic: string | undefined, fn: (payload: string) => void): void {
    if (!topic) return;
    let set = this.#topicListeners.get(topic);
    if (!set) {
      this.#topicListeners.set(topic, (set = new Set()));
      this.#client?.subscribe(topic);
    }
    set.add(fn);
    device.listeners.push({ topic, fn });
  }

  #detach(device: DeviceRecord): void {
    for (const { topic, fn } of device.listeners) {
      const set = this.#topicListeners.get(topic);
      set?.delete(fn);
      if (set && set.size === 0) {
        this.#topicListeners.delete(topic);
        this.#client?.unsubscribe(topic);
      }
    }
    device.listeners = [];
  }

  // ---------------------------------------------------------------- availability

  #wireAvailability(device: DeviceRecord): void {
    for (const source of availabilitySources([...device.entities.values()].map((e) => e.config))) {
      const template = compileTemplate(source.value_template);
      this.#listen(device, source.topic, (payload) => {
        const value = template.render(payload);
        if (payloadEquals(value, source.payload_available ?? 'online')) device.availability = true;
        else if (payloadEquals(value, source.payload_not_available ?? 'offline')) device.availability = false;
        else return;
        this.#refreshAvailability(device);
      });
    }
  }

  /** Online when the broker is reachable and, if the device publishes availability, it says so. */
  #refreshAvailability(device: DeviceRecord): void {
    if (!device.handle) return;
    if (!this.#client?.connected) return device.handle.setAvailability('offline');
    const hasSources = availabilitySources([...device.entities.values()].map((e) => e.config)).length > 0;
    if (!hasSources) return device.handle.setAvailability('online');
    if (device.availability !== undefined) device.handle.setAvailability(device.availability ? 'online' : 'offline');
  }

  // ---------------------------------------------------------------- state & commands

  #wireEntity(device: DeviceRecord, handle: DeviceHandle, entity: EntityRecord): void {
    const { config, endpointId: ep } = entity;
    const publish = (topic: string | undefined, payload: string): Promise<void> => {
      if (!topic) throw new Error('Entity has no command topic');
      if (!this.#client?.connected) throw new Error('MQTT broker is not connected');
      return this.#client.publishAsync(topic, payload, { qos: (Number(config.qos ?? 0) as 0 | 1 | 2), retain: Boolean(config.retain) }).then(() => {});
    };
    const handlers = (capability: string, map: Record<string, CommandHandler>) => handle.handle(ep, capability, map);

    switch (entity.component) {
      case 'cover':
      case 'climate':
      case 'fan':
      case 'lock':
      case 'device_automation':
      case 'event':
        return wireExtended(entity.component, {
          config,
          plan: entity.plan,
          listen: (topic, fn) => this.#listen(device, topic, fn),
          publish,
          update: (capability, attributes) => handle.update(ep, capability, attributes),
          get: (capability, attribute) => handle.get(ep, capability, attribute),
          handle: (capability, map) => handle.handle(ep, capability, map),
          warn: (message) => this.#warnOnce(entity.discoveryTopic, message),
        });
      case 'light':
        return config.schema === 'json' ? this.#wireJsonLight(device, handle, entity, publish) : this.#wireDefaultLight(device, handle, entity, publish);
      case 'switch': {
        const on = str(config.payload_on, 'ON');
        const off = str(config.payload_off, 'OFF');
        const stateOn = config.state_on ?? on;
        const stateOff = config.state_off ?? off;
        const value = compileTemplate(config.value_template as string | undefined);
        const command = compileTemplate(config.command_template as string | undefined);
        this.#listen(device, config.state_topic, (payload) => {
          const rendered = value.render(payload);
          if (payloadEquals(rendered, stateOn)) handle.update(ep, 'onOff', { onOff: true });
          else if (payloadEquals(rendered, stateOff)) handle.update(ep, 'onOff', { onOff: false });
        });
        const send = (v: string) => publish(config.command_topic, String(command.render(v)));
        handlers('onOff', {
          on: () => send(on),
          off: () => send(off),
          toggle: () => send(handle.get(ep, 'onOff', 'onOff') ? off : on),
        });
        return;
      }
      case 'sensor': {
        const value = compileTemplate(config.value_template as string | undefined);
        const fahrenheit = config.unit_of_measurement === '°F';
        this.#listen(device, config.state_topic, (payload) => {
          const raw = value.render(payload);
          const n = typeof raw === 'number' ? raw : Number(raw);
          if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return;
          switch (entity.plan.capabilities[0]) {
            case 'temperatureMeasurement':
              return handle.update(ep, 'temperatureMeasurement', { measuredValue: fahrenheit ? round1(((n - 32) * 5) / 9) : n });
            case 'relativeHumidityMeasurement':
              return handle.update(ep, 'relativeHumidityMeasurement', { measuredValue: n });
            case 'illuminanceMeasurement':
              return handle.update(ep, 'illuminanceMeasurement', { measuredValue: n });
            case 'powerSource':
              return handle.update(ep, 'powerSource', { batPercentRemaining: n, batChargeLevelLow: n < 20 });
            case 'electricalPowerMeasurement':
              return handle.update(ep, 'electricalPowerMeasurement', { activePower: n });
          }
        });
        return;
      }
      case 'binary_sensor': {
        const value = compileTemplate(config.value_template as string | undefined);
        const on = config.payload_on ?? 'ON';
        const off = config.payload_off ?? 'OFF';
        this.#listen(device, config.state_topic, (payload) => {
          const rendered = value.render(payload);
          const isOn = payloadEquals(rendered, on) ? true : payloadEquals(rendered, off) ? false : undefined;
          if (isOn === undefined) return;
          if (entity.plan.capabilities[0] === 'occupancySensing') handle.update(ep, 'occupancySensing', { occupied: isOn });
          // HA: "on" means open for door/window; Matter BooleanState: true means contact closed. For leaks, true = leak.
          else if (entity.plan.deviceType === 'binarySensor.contact') handle.update(ep, 'booleanState', { stateValue: !isOn });
          else handle.update(ep, 'booleanState', { stateValue: isOn });
        });
        return;
      }
    }
  }

  #wireJsonLight(device: DeviceRecord, handle: DeviceHandle, entity: EntityRecord, publish: (t: string | undefined, p: string) => Promise<void>): void {
    const { config, endpointId: ep } = entity;
    const scale = Number(config.brightness_scale ?? 255);
    const modes = lightColorModes(config);
    const caps = entity.plan.capabilities;
    if (caps.includes('colorControl')) {
      handle.update(ep, 'colorControl', {
        colorTempPhysicalMinMireds: Number(config.min_mireds ?? 153),
        colorTempPhysicalMaxMireds: Number(config.max_mireds ?? 500),
      });
    }
    this.#listen(device, config.state_topic, (payload) => {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (typeof data.state === 'string') handle.update(ep, 'onOff', { onOff: data.state.toUpperCase() === 'ON' });
      if (caps.includes('levelControl') && typeof data.brightness === 'number') {
        handle.update(ep, 'levelControl', { currentLevel: percentToLevel((data.brightness / scale) * 100) });
      }
      if (caps.includes('colorControl')) {
        const update: Record<string, AttributeValue> = {};
        if (typeof data.color_temp === 'number') update.colorTemperatureMireds = data.color_temp;
        const color = data.color as Record<string, number> | undefined;
        const hs = color
          ? color.h !== undefined
            ? { h: color.h, s: color.s ?? 0 }
            : color.hue !== undefined
              ? { h: color.hue, s: color.saturation ?? 0 }
              : color.x !== undefined
                ? xyToHs(color.x, color.y ?? 0)
                : undefined
          : undefined;
        if (hs) Object.assign(update, { currentHue: degreesToHue(hs.h), currentSaturation: percentToSat(hs.s) });
        if (data.color_mode === 'color_temp') update.colorMode = 'ct';
        else if (typeof data.color_mode === 'string' && hs) update.colorMode = 'hs';
        if (Object.keys(update).length) handle.update(ep, 'colorControl', update);
      }
    });
    const send = (body: Record<string, unknown>, params: Record<string, unknown> = {}) =>
      publish(config.command_topic, JSON.stringify(params.transitionTime === undefined ? body : { ...body, transition: Number(params.transitionTime) / 10 }));
    handle.handle(ep, 'onOff', {
      on: () => send({ state: 'ON' }),
      off: () => send({ state: 'OFF' }),
      toggle: () => send({ state: handle.get(ep, 'onOff', 'onOff') ? 'OFF' : 'ON' }),
    });
    if (caps.includes('levelControl')) {
      handle.handle(ep, 'levelControl', {
        moveToLevel: (p) => send({ state: 'ON', brightness: Math.max(1, Math.round((levelToPercent(Number(p.level)) / 100) * scale)) }, p),
      });
    }
    if (caps.includes('colorControl')) {
      handle.handle(ep, 'colorControl', {
        moveToColorTemperature: (p) => send({ state: 'ON', color_temp: Number(p.colorTemperatureMireds) }, p),
        moveToHueAndSaturation: (p) => {
          const h = hueToDegrees(Number(p.hue));
          const s = satToPercent(Number(p.saturation));
          const color = modes.includes('hs') ? { h, s } : modes.includes('xy') ? hsToXy(h, s) : hsToRgb(h, s);
          return send({ state: 'ON', color }, p);
        },
      });
    }
  }

  #wireDefaultLight(device: DeviceRecord, handle: DeviceHandle, entity: EntityRecord, publish: (t: string | undefined, p: string) => Promise<void>): void {
    const { config, endpointId: ep } = entity;
    const on = str(config.payload_on, 'ON');
    const off = str(config.payload_off, 'OFF');
    const scale = Number(config.brightness_scale ?? 255);
    const caps = entity.plan.capabilities;
    const stateTpl = compileTemplate(config.state_value_template as string | undefined);
    const brightnessTpl = compileTemplate(config.brightness_value_template as string | undefined);
    const ctTpl = compileTemplate(config.color_temp_value_template as string | undefined);
    const hsTpl = compileTemplate(config.hs_value_template as string | undefined);
    this.#listen(device, config.state_topic, (payload) => {
      const v = stateTpl.render(payload);
      if (payloadEquals(v, on)) handle.update(ep, 'onOff', { onOff: true });
      else if (payloadEquals(v, off)) handle.update(ep, 'onOff', { onOff: false });
    });
    if (caps.includes('levelControl')) {
      this.#listen(device, config.brightness_state_topic as string | undefined, (payload) => {
        const n = Number(brightnessTpl.render(payload));
        if (Number.isFinite(n)) handle.update(ep, 'levelControl', { currentLevel: percentToLevel((n / scale) * 100) });
      });
    }
    if (caps.includes('colorControl')) {
      this.#listen(device, config.color_temp_state_topic as string | undefined, (payload) => {
        const n = Number(ctTpl.render(payload));
        if (Number.isFinite(n)) handle.update(ep, 'colorControl', { colorTemperatureMireds: n });
      });
      this.#listen(device, config.hs_state_topic as string | undefined, (payload) => {
        const [h, s] = String(hsTpl.render(payload)).split(',').map(Number);
        if (Number.isFinite(h) && Number.isFinite(s)) handle.update(ep, 'colorControl', { currentHue: degreesToHue(h!), currentSaturation: percentToSat(s!), colorMode: 'hs' });
      });
    }
    handle.handle(ep, 'onOff', {
      on: () => publish(config.command_topic, on),
      off: () => publish(config.command_topic, off),
      toggle: () => publish(config.command_topic, handle.get(ep, 'onOff', 'onOff') ? off : on),
    });
    if (caps.includes('levelControl')) {
      handle.handle(ep, 'levelControl', {
        moveToLevel: (p) =>
          publish(config.brightness_command_topic as string | undefined, String(Math.max(1, Math.round((levelToPercent(Number(p.level)) / 100) * scale)))),
      });
    }
    if (caps.includes('colorControl')) {
      handle.handle(ep, 'colorControl', {
        moveToColorTemperature: (p) => publish(config.color_temp_command_topic as string | undefined, String(p.colorTemperatureMireds)),
        moveToHueAndSaturation: (p) =>
          publish(config.hs_command_topic as string | undefined, `${hueToDegrees(Number(p.hue))},${satToPercent(Number(p.saturation))}`),
      });
    }
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(`${key}:${message}`)) return;
    this.#warned.add(`${key}:${message}`);
    this.#ctx.log.warn({ key }, message);
  }
}

interface AvailabilitySource {
  topic: string;
  payload_available?: string;
  payload_not_available?: string;
  value_template?: string;
}

function availabilitySources(configs: DiscoveryConfig[]): AvailabilitySource[] {
  const seen = new Map<string, AvailabilitySource>();
  for (const c of configs) {
    if (c.availability_topic) {
      seen.set(c.availability_topic, {
        topic: c.availability_topic,
        payload_available: c.payload_available as string | undefined,
        payload_not_available: c.payload_not_available as string | undefined,
        value_template: c.availability_template as string | undefined,
      });
    }
    for (const a of c.availability ?? []) if (a.topic) seen.set(a.topic, a);
  }
  return [...seen.values()];
}

function entityName(e: EntityRecord): string | undefined {
  return typeof e.config.name === 'string' && e.config.name.trim() ? e.config.name : undefined;
}

function str(v: unknown, fallback: string): string {
  return v === undefined || v === null ? fallback : String(v);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function hsToRgb(h: number, s: number): { r: number; g: number; b: number } {
  const c = s / 100;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

