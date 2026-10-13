import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import hap from 'hap-nodejs';
import type { Accessory as HapAccessory, Characteristic as HapCharacteristic, CharacteristicValue, HAPStatus, Service as HapService } from 'hap-nodejs';
import { LivynqError, type Exporter, type Home, type Logger } from '@livynq/core';
import type { Device, DeviceId, HomeKitBridgeInfo } from '@livynq/model';
import { accessoriesFor, type AccessoryPlan, type CharacteristicBinding, type ServicePlan } from './mapping.ts';

const { Accessory, Bridge, Characteristic, HapStatusError, Service, uuid, HAPStorage } = hap;

// HAP-NodeJS declares these as const enums, which isolated modules cannot inline.
const COMMUNICATION_FAILURE = -70402 as HAPStatus;
const CATEGORY_BRIDGE = 2;

export interface HomeKitExporterOptions {
  name: string;
  /** Port of the first bridge; additional bridges use the following ports. */
  port: number;
  /** Directory for bridge identities, accessory→bridge assignments and HAP-NodeJS caches. Must be backed up. */
  storagePath: string;
  pincode?: string;
  bind?: string[];
  firmwareRevision?: string;
  /** Accessories per bridge before another bridge is created (HAP maximum and default: 149). */
  maxAccessoriesPerBridge?: number;
}

interface BridgeIdentity {
  username: string;
  pincode: string;
  setupID: string;
}

interface Slot {
  index: number;
  identity: BridgeIdentity;
  bridge: InstanceType<typeof Bridge>;
  port: number;
  paired: boolean;
  published: boolean;
  keys: Set<string>;
}

interface Exposed {
  deviceId: DeviceId;
  slot: Slot;
  accessory: HapAccessory;
  /** endpointId -> bindings to refresh when that endpoint changes */
  bindings: Map<number, { characteristic: HapCharacteristic; binding: CharacteristicBinding }[]>;
  signature: string;
}

/**
 * Exposes Livynq devices to Apple Home through HAP bridges.
 * - Accessory UUIDs derive from device ids; HAP-NodeJS persists AID/IID per UUID and never purges
 *   them, so Apple Home rooms, scenes and automations survive restarts, hiding and re-adding.
 * - Bridges hold up to 149 accessories; more bridges are created on demand. Which bridge an
 *   accessory lives on is persisted and never changes (moving it would look like a new accessory).
 * - Multi-channel devices are split into one accessory per channel.
 */
export class HomeKitExporter implements Exporter {
  readonly id = 'homekit';
  readonly #options: HomeKitExporterOptions;
  #home!: Home;
  #log!: Logger;
  readonly #slots: Slot[] = [];
  #assignments: Record<string, number> = {};
  readonly #exposed = new Map<string, Exposed>();
  readonly #byDevice = new Map<DeviceId, Set<string>>();
  readonly #offs: (() => void)[] = [];
  readonly #pending = new Map<string, { timer: NodeJS.Timeout | undefined; values: Record<string, string | number | boolean>; resolvers: { resolve: () => void; reject: (e: unknown) => void }[] }>();
  #started = false;

  constructor(options: HomeKitExporterOptions) {
    this.#options = options;
  }

  get #max(): number {
    return Math.min(149, this.#options.maxAccessoriesPerBridge ?? 149);
  }

  async start(home: Home): Promise<void> {
    this.#home = home;
    this.#log = home.log.child({ exporter: 'homekit' });
    mkdirSync(this.#options.storagePath, { recursive: true, mode: 0o700 });
    setHapStoragePath(this.#options.storagePath);
    const assignmentsFile = join(this.#options.storagePath, 'assignments.json');
    this.#assignments = existsSync(assignmentsFile) ? (JSON.parse(readFileSync(assignmentsFile, 'utf8')) as Record<string, number>) : {};
    // Recreate every bridge that ever existed so their pairings stay alive, even if empty for now.
    const highest = Math.max(0, ...Object.values(this.#assignments));
    for (let i = 0; i <= highest; i++) this.#slot(i);

    // Publish persisted devices right away; adapters fill in state as they come up.
    for (const device of home.registry.listDevices()) this.#sync(device, true);
    this.#offs.push(
      home.bus.on('device.added', (d) => this.#sync(d)),
      home.bus.on('device.updated', (d) => this.#sync(d)),
      home.bus.on('device.removed', ({ id }) => this.#removeDevice(id)),
      home.bus.on('state', (c) => this.#refresh(c.deviceId, c.endpointId)),
      home.bus.on('availability', ({ deviceId }) => this.#refreshAll(deviceId)),
    );
    this.#started = true;
    for (const slot of this.#slots) await this.#publish(slot);
  }

  async stop(): Promise<void> {
    this.#started = false;
    for (const off of this.#offs.splice(0)) off();
    for (const p of this.#pending.values()) clearTimeout(p.timer);
    for (const slot of this.#slots) if (slot.published) await slot.bridge.unpublish();
    this.#slots.length = 0;
  }

  bridges(): HomeKitBridgeInfo[] {
    return this.#slots.map((slot) => ({
      id: slot.index === 0 ? 'main' : `bridge-${slot.index + 1}`,
      name: this.#bridgeName(slot.index),
      pincode: slot.identity.pincode,
      setupURI: slot.bridge.setupURI(),
      port: slot.port,
      paired: slot.paired,
      accessoryCount: slot.keys.size,
    }));
  }

  /** HAP accessory ids per accessory key: diagnostics, and the stability guarantee tests rely on. */
  accessoryIds(): Record<string, number | undefined> {
    return Object.fromEntries([...this.#exposed].map(([key, e]) => [key, e.accessory.aid ?? undefined]));
  }

  /** Accessory key → bridge index. */
  assignments(): Record<string, number> {
    return { ...this.#assignments };
  }

  #bridgeName(index: number): string {
    return index === 0 ? this.#options.name : `${this.#options.name} ${index + 1}`;
  }

  #slot(index: number): Slot {
    const existing = this.#slots[index];
    if (existing) return existing;
    const identity = this.#loadIdentity(index);
    const bridge = new Bridge(this.#bridgeName(index), uuid.generate(`livynq:bridge:${identity.username}`));
    // Keep AIDs/IIDs of accessories that are temporarily gone (hidden, adapter down, removed) so they
    // come back with the same ids and Apple Home keeps their rooms, scenes and automations.
    bridge.shouldPurgeUnusedIDs = false;
    bridge
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Livynq')
      .setCharacteristic(Characteristic.Model, 'Livynq Bridge')
      .setCharacteristic(Characteristic.SerialNumber, identity.username)
      .setCharacteristic(Characteristic.FirmwareRevision, this.#options.firmwareRevision ?? '0.1.0');
    const slot: Slot = { index, identity, bridge, port: this.#options.port + index, paired: false, published: false, keys: new Set() };
    bridge.on('paired', () => {
      slot.paired = true;
      this.#log.info({ bridge: this.#bridgeName(index) }, 'paired with Apple Home');
    });
    bridge.on('unpaired', () => {
      slot.paired = false;
      this.#log.info({ bridge: this.#bridgeName(index) }, 'unpaired from Apple Home');
    });
    this.#slots[index] = slot;
    if (this.#started) void this.#publish(slot);
    return slot;
  }

  async #publish(slot: Slot): Promise<void> {
    if (slot.published) return;
    slot.published = true;
    await slot.bridge.publish({
      username: slot.identity.username,
      pincode: slot.identity.pincode,
      setupID: slot.identity.setupID,
      port: slot.port,
      category: CATEGORY_BRIDGE,
      bind: this.#options.bind,
      advertiser: 'ciao' as never,
    });
    slot.paired = (slot.bridge._accessoryInfo?.listPairings().length ?? 0) > 0;
    this.#log.info({ bridge: this.#bridgeName(slot.index), port: slot.port, pincode: slot.identity.pincode, accessories: slot.keys.size, paired: slot.paired }, 'HomeKit bridge published');
  }

  #loadIdentity(index: number): BridgeIdentity {
    const file = join(this.#options.storagePath, index === 0 ? 'bridge.json' : `bridge-${index + 1}.json`);
    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as BridgeIdentity;
      return { ...stored, pincode: index === 0 ? (this.#options.pincode ?? stored.pincode) : stored.pincode };
    }
    const identity: BridgeIdentity = {
      username: [...randomBytes(6)].map((b, i) => (i === 0 ? (b & 0xfc) | 0x02 : b).toString(16).padStart(2, '0').toUpperCase()).join(':'),
      pincode: index === 0 && this.#options.pincode ? this.#options.pincode : generatePincode(),
      setupID: [...randomBytes(4)].map((b) => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[b % 36]).join(''),
    };
    writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
    return identity;
  }

  /** Persistent bridge for an accessory: its previous bridge, else the first with room. */
  #slotFor(key: string): Slot {
    const assigned = this.#assignments[key];
    if (assigned !== undefined) {
      const slot = this.#slot(assigned);
      if (slot.keys.size < this.#max || slot.keys.has(key)) return slot;
      this.#log.warn({ accessory: key }, 'its bridge is full; moving it to another bridge (Apple Home will treat it as new)');
    }
    let index = 0;
    while (this.#slot(index).keys.size >= this.#max) index++;
    this.#assignments[key] = index;
    writeFileSync(join(this.#options.storagePath, 'assignments.json'), JSON.stringify(this.#assignments, null, 2), { mode: 0o600 });
    return this.#slot(index);
  }

  // ---------------------------------------------------------------- accessories

  #sync(device: Device, initial = false): void {
    const plans = device.exposure.homekit ? accessoriesFor(device) : [];
    const wanted = new Set(plans.map((p) => p.key));
    for (const key of this.#byDevice.get(device.id) ?? []) if (!wanted.has(key)) this.#remove(key);
    for (const plan of plans) this.#syncAccessory(device, plan, initial);
  }

  #syncAccessory(device: Device, plan: AccessoryPlan, initial: boolean): void {
    const signature = JSON.stringify(plan.services.map((p) => [p.key, p.service, p.characteristics.map((c) => c.name)]));
    const existing = this.#exposed.get(plan.key);
    if (existing && existing.signature === signature) {
      existing.accessory.getService(Service.AccessoryInformation)?.updateCharacteristic(Characteristic.Name, plan.name);
      return this.#refreshAll(device.id);
    }
    if (existing) this.#remove(plan.key);

    const accessory = new Accessory(plan.name, uuid.generate(`livynq:device:${plan.key}`));
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, device.info.manufacturer || 'Livynq')
      .setCharacteristic(Characteristic.Model, device.info.model || device.protocol)
      .setCharacteristic(Characteristic.SerialNumber, device.info.serial || plan.key)
      .setCharacteristic(Characteristic.FirmwareRevision, sanitizeVersion(device.info.firmware));

    const bindings = new Map<number, { characteristic: HapCharacteristic; binding: CharacteristicBinding }[]>();
    for (const service of plan.services) {
      const hapService = this.#createService(plan, service, accessory);
      for (const binding of service.characteristics) {
        const characteristic = hapService.getCharacteristic((Characteristic as unknown as Record<string, never>)[binding.name]!);
        if (binding.props) characteristic.setProps(binding.props);
        characteristic.onGet(() => this.#read(device.id, service.endpointId, binding));
        if (binding.write) {
          const write = binding.write;
          characteristic.onSet((value) => this.#write(device.id, service.endpointId, binding.name, value, write));
        }
        const list = bindings.get(service.endpointId) ?? [];
        list.push({ characteristic, binding });
        bindings.set(service.endpointId, list);
      }
    }
    const slot = this.#slotFor(plan.key);
    slot.keys.add(plan.key);
    this.#exposed.set(plan.key, { deviceId: device.id, slot, accessory, bindings, signature });
    let keys = this.#byDevice.get(device.id);
    if (!keys) this.#byDevice.set(device.id, (keys = new Set()));
    keys.add(plan.key);
    slot.bridge.addBridgedAccessory(accessory, initial);
    this.#refreshAll(device.id);
  }

  #createService(accessory: AccessoryPlan, plan: ServicePlan, hapAccessory: HapAccessory): HapService {
    const ServiceType = (Service as unknown as Record<string, typeof HapService>)[plan.service]!;
    const name = plan.name ? `${accessory.name} ${plan.name}` : accessory.name;
    const service = hapAccessory.addService(ServiceType, name, plan.key);
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    return service;
  }

  #remove(key: string): void {
    const exposed = this.#exposed.get(key);
    if (!exposed) return;
    this.#exposed.delete(key);
    this.#byDevice.get(exposed.deviceId)?.delete(key);
    exposed.slot.keys.delete(key);
    exposed.slot.bridge.removeBridgedAccessory(exposed.accessory);
  }

  #removeDevice(id: DeviceId): void {
    for (const key of [...(this.#byDevice.get(id) ?? [])]) this.#remove(key);
    this.#byDevice.delete(id);
  }

  #read(deviceId: DeviceId, endpointId: number, binding: CharacteristicBinding): CharacteristicValue {
    const device = this.#home.registry.getDevice(deviceId);
    if (!device || device.availability === 'offline') throw new HapStatusError(COMMUNICATION_FAILURE);
    return binding.read(this.#home.registry.getState(deviceId)[endpointId] ?? {});
  }

  #refresh(deviceId: DeviceId, endpointId: number): void {
    const device = this.#home.registry.getDevice(deviceId);
    if (!device) return;
    const state = this.#home.registry.getState(deviceId)[endpointId] ?? {};
    for (const key of this.#byDevice.get(deviceId) ?? []) {
      for (const { characteristic, binding } of this.#exposed.get(key)?.bindings.get(endpointId) ?? []) {
        characteristic.updateValue(device.availability === 'offline' ? new HapStatusError(COMMUNICATION_FAILURE) : binding.read(state));
      }
    }
  }

  #refreshAll(deviceId: DeviceId): void {
    const endpoints = new Set<number>();
    for (const key of this.#byDevice.get(deviceId) ?? []) for (const ep of this.#exposed.get(key)?.bindings.keys() ?? []) endpoints.add(ep);
    for (const ep of endpoints) this.#refresh(deviceId, ep);
  }

  /**
   * Coalesces rapid writes (brightness/hue sliders send many values) into one command per 100 ms,
   * and turns command failures into "No Response" instead of a hanging Home app.
   */
  #write(deviceId: DeviceId, endpointId: number, characteristic: string, value: CharacteristicValue, write: NonNullable<CharacteristicBinding['write']>): Promise<void> {
    const key = `${deviceId}#${endpointId}#${write.coalesceKey ?? characteristic}`;
    let entry = this.#pending.get(key);
    if (!entry) this.#pending.set(key, (entry = { timer: undefined, values: {}, resolvers: [] }));
    clearTimeout(entry.timer);
    entry.values[characteristic] = value as string | number | boolean;
    const promise = new Promise<void>((resolve, reject) => entry.resolvers.push({ resolve, reject }));
    const current = entry;
    current.timer = setTimeout(async () => {
      this.#pending.delete(key);
      const state = this.#home.registry.getState(deviceId)[endpointId] ?? {};
      try {
        for (const cmd of write.commands(current.values, state)) {
          await this.#home.command({ deviceId, endpointId, ...cmd }, 'homekit');
        }
        current.resolvers.forEach((r) => r.resolve());
      } catch (err) {
        this.#log.warn({ deviceId, characteristic, err: err instanceof LivynqError ? err.message : String(err) }, 'HomeKit write failed');
        current.resolvers.forEach((r) => r.reject(new HapStatusError(COMMUNICATION_FAILURE)));
      }
    }, 100);
    return promise;
  }
}

/** HAP-NodeJS storage is a process-wide singleton whose path can be set only once. */
function setHapStoragePath(path: string): void {
  const instance = (HAPStorage as unknown as { INSTANCE: { customStoragePath?: string; localStore?: unknown } }).INSTANCE;
  if (!instance.localStore) return HAPStorage.setCustomStoragePath(path);
  if (instance.customStoragePath !== path) {
    throw new Error(`HomeKit storage is already initialised at ${instance.customStoragePath}; one storage path per process`);
  }
}

const INVALID_PINS = new Set(['00000000', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777', '88888888', '99999999', '12345678', '87654321']);

function generatePincode(): string {
  let digits: string;
  do digits = String(randomInt(0, 100_000_000)).padStart(8, '0');
  while (INVALID_PINS.has(digits));
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/** HAP requires x[.y[.z]] numeric firmware strings. */
function sanitizeVersion(version: string | undefined): string {
  const match = version?.match(/\d+(\.\d+){0,2}/);
  return match ? match[0] : '1.0.0';
}
