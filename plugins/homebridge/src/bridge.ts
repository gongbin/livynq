import type { PluginContext, PluginDevice } from '@livynq/sdk';
import type { Characteristic, Service } from 'hap-nodejs';
import { hap } from './hap.ts';
import { SKIPPED_SILENTLY, buttonUpdate, commandToWrites, featureCommands, featureUpdates, planService, type Feature } from './mapping.ts';
import type { Bridged } from './runtime.ts';

/**
 * Bridged Homebridge accessories → Livynq devices. Values flow in from characteristic change
 * events (updateValue / setValue / writes) and from polling the plugin's get handlers, since many
 * plugins only answer reads.
 */

export interface AccessoryReport {
  uuid: string;
  id: string;
  name: string;
  plugin: string;
  platform?: string;
  source: Bridged['source'];
  state: 'online' | 'offline' | 'unsupported';
  mapped: { kind: string; name?: string }[];
  unsupported: string[];
  error?: string;
}

interface Item {
  b: Bridged;
  device?: PluginDevice;
  features: { feature: Feature; endpointId: number }[];
  report: AccessoryReport;
  off: () => void;
  replan?: ReturnType<typeof setTimeout>;
}

const READ_TIMEOUT_MS = 10_000;

/** Homebridge's "not responding" status codes. */
const COMM_FAILURE = new Set([-70402, -70408]);

function serviceTypeName(s: Service): string {
  for (const [name, ctor] of Object.entries(hap.Service)) {
    if ((ctor as { UUID?: string } | undefined)?.UUID === s.UUID) return name;
  }
  return s.displayName || s.UUID;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });

const statusOf = (err: unknown) => (err && typeof err === 'object' && 'hapStatus' in err ? Number((err as { hapStatus: number }).hapStatus) : undefined);
const describeError = (err: unknown) => {
  const s = statusOf(err);
  if (s !== undefined && COMM_FAILURE.has(s)) return 'the device is not responding';
  if (s !== undefined) return `HomeKit status ${s}`;
  return err instanceof Error ? err.message : String(err);
};

export class DeviceBridge {
  readonly #ctx: PluginContext;
  readonly #items = new Map<string, Item>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(ctx: PluginContext, options: { pollMs: number }) {
    this.#ctx = ctx;
    this.#timer = setInterval(() => void this.pollAll(), options.pollMs);
    this.#timer.unref?.();
  }

  add(b: Bridged): void {
    void this.#publish(b).catch((err: Error) => this.#ctx.log.error(`[${b.plugin}] ${b.accessory.displayName}: ${err.message}`));
  }

  changed(b: Bridged): void {
    const item = this.#items.get(b.uuid);
    if (item) item.b = b;
    this.#schedule(b.uuid);
  }

  async remove(uuid: string): Promise<void> {
    const item = this.#items.get(uuid);
    if (!item) return;
    item.off();
    clearTimeout(item.replan);
    this.#items.delete(uuid);
    if (item.device) await this.#ctx.devices.remove(item.device.id);
  }

  report(): AccessoryReport[] {
    return [...this.#items.values()].map((i) => i.report);
  }

  #schedule(uuid: string): void {
    const item = this.#items.get(uuid);
    if (!item) return;
    clearTimeout(item.replan);
    item.replan = setTimeout(() => void this.#publish(item.b).catch((err: Error) => this.#ctx.log.error(err.message)), 500);
  }

  async #publish(b: Bridged): Promise<void> {
    if (this.#closed) return;
    const prev = this.#items.get(b.uuid);
    prev?.off();
    const acc = b.accessory;
    // As in Homebridge (Bridge.addBridgedAccessory): hap-nodejs forwards characteristic and
    // service changes as accessory events only for bridged accessories.
    acc.bridged = true;
    const skip = SKIPPED_SILENTLY();
    const features: Feature[] = [];
    const unsupported: string[] = [];
    for (const s of acc.services) {
      if (skip.has(s.UUID)) continue;
      const f = planService(s);
      if (f) features.push(f);
      else unsupported.push(serviceTypeName(s));
    }
    const id = `homebridge:${b.uuid}`;
    const report: AccessoryReport = {
      uuid: b.uuid,
      id,
      name: acc.displayName,
      plugin: b.plugin,
      ...(b.platform ? { platform: b.platform } : {}),
      source: b.source,
      state: features.length ? 'online' : 'unsupported',
      mapped: features.map((f) => ({ kind: f.kind, ...(f.name ? { name: f.name } : {}) })),
      unsupported,
    };
    const item: Item = { b, features: [], report, off: () => {} };
    this.#items.set(b.uuid, item);
    // Services added or removed later (common after configureAccessory) → plan again.
    const onConfig = () => this.#schedule(b.uuid);
    acc.on('service-configurationChange', onConfig);
    if (!features.length) {
      item.off = () => acc.removeListener('service-configurationChange', onConfig);
      if (prev?.device) await this.#ctx.devices.remove(prev.device.id);
      if (unsupported.length) this.#ctx.log.info(`[${b.plugin}] ${acc.displayName}: no supported services (${unsupported.join(', ')})`);
      return;
    }

    const bound = await Promise.all(features.map(async (feature) => ({ feature, endpointId: await this.#ctx.endpointId(id, feature.key) })));
    bound.sort((x, y) => x.endpointId - y.endpointId);
    const info = acc.getService(hap.Service.AccessoryInformation);
    const str = (c: { UUID: string }) => {
      const v = info?.characteristics.find((x) => x.UUID === c.UUID)?.value;
      return typeof v === 'string' && v.trim() && v !== 'Default-Manufacturer' && v !== 'Default-Model' && v !== 'Default-SerialNumber' ? v.trim() : undefined;
    };
    const device = await this.#ctx.devices.upsert({
      id,
      name: acc.displayName,
      protocol: 'homebridge',
      info: {
        manufacturer: str(hap.Characteristic.Manufacturer) ?? b.plugin,
        model: str(hap.Characteristic.Model),
        serial: str(hap.Characteristic.SerialNumber),
        firmware: str(hap.Characteristic.FirmwareRevision),
      },
      endpoints: bound.map((x) => ({ id: x.endpointId, deviceType: x.feature.deviceType, capabilities: x.feature.capabilities, ...(bound.length > 1 && x.feature.name ? { name: x.feature.name } : {}) })),
    });
    item.device = device;
    item.features = bound;

    for (const { feature, endpointId } of bound) {
      for (const [capability, commands] of Object.entries(featureCommands(feature))) {
        device.handle(
          endpointId,
          capability,
          Object.fromEntries(
            commands.map((command) => [
              command,
              async (params: Record<string, unknown>) => {
                for (const w of commandToWrites(feature, capability, command, params)) {
                  try {
                    await withTimeout(w.characteristic.handleSetRequest(w.value as never), READ_TIMEOUT_MS, `${acc.displayName}: ${w.characteristic.displayName}`);
                  } catch (err) {
                    throw new Error(`${acc.displayName}: ${describeError(err)}`);
                  }
                }
                this.#push(item, feature, endpointId);
              },
            ]),
          ),
        );
      }
    }

    const onChange = (change: { service: Service; characteristic: Characteristic; newValue: unknown; reason?: string }) => {
      const hit = item.features.find((x) => x.feature.service === change.service);
      if (!hit || !item.device) return;
      if (hit.feature.kind === 'button') {
        if (change.characteristic.UUID !== hap.Characteristic.ProgrammableSwitchEvent.UUID || change.reason === 'read') return;
        const u = buttonUpdate(change.newValue);
        if (u) item.device.update(hit.endpointId, u.capability, u.attributes);
        return;
      }
      this.#push(item, hit.feature, hit.endpointId);
    };
    acc.on('service-characteristic-change', onChange as never);
    item.off = () => {
      acc.removeListener('service-characteristic-change', onChange as never);
      acc.removeListener('service-configurationChange', onConfig);
    };
    await this.#poll(item);
  }

  #push(item: Item, feature: Feature, endpointId: number): void {
    if (!item.device) return;
    for (const u of featureUpdates(feature)) item.device.update(endpointId, u.capability, u.attributes);
  }

  /** Asks every mapped characteristic for its value (the plugin's onGet / 'get' handlers). */
  async #poll(item: Item): Promise<void> {
    if (!item.device) return;
    let failures = 0;
    let reads = 0;
    let lastError: unknown;
    for (const { feature, endpointId } of item.features) {
      for (const c of Object.values(feature.chars)) {
        if (c.UUID === hap.Characteristic.ProgrammableSwitchEvent.UUID) continue;
        reads++;
        try {
          await withTimeout(c.handleGetRequest(), READ_TIMEOUT_MS, `${item.b.accessory.displayName}: ${c.displayName}`);
        } catch (err) {
          failures++;
          lastError = err;
        }
      }
      this.#push(item, feature, endpointId);
    }
    const offline = reads > 0 && failures === reads;
    item.report.state = offline ? 'offline' : 'online';
    if (lastError) item.report.error = describeError(lastError);
    else delete item.report.error;
    item.device.setAvailability(offline ? 'offline' : 'online');
  }

  async pollAll(): Promise<void> {
    for (const item of this.#items.values()) {
      if (this.#closed) return;
      await this.#poll(item).catch(() => {});
    }
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const item of this.#items.values()) {
      item.off();
      clearTimeout(item.replan);
    }
  }
}
