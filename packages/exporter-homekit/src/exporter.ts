import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import hap from 'hap-nodejs';
import type { Accessory as HapAccessory, Characteristic as HapCharacteristic, CharacteristicValue, HAPStatus, Service as HapService } from 'hap-nodejs';
import { LivynqError, type Exporter, type Home, type Logger } from '@livynq/core';
import type { Device, DeviceId, HomeKitBridgeInfo } from '@livynq/model';
import { servicesFor, type CharacteristicBinding, type ServicePlan } from './mapping.ts';

const { Accessory, Bridge, Characteristic, HapStatusError, Service, uuid, HAPStorage } = hap;

// HAP-NodeJS declares these as const enums, which isolated modules cannot inline.
const COMMUNICATION_FAILURE = -70402 as HAPStatus;
const CATEGORY_BRIDGE = 2;

/** HAP limit is 150 accessories per bridge including the bridge itself. */
const MAX_BRIDGED = 149;

export interface HomeKitExporterOptions {
  name: string;
  port: number;
  /** Directory for the bridge identity and HAP-NodeJS pairing/ID caches. Must be backed up. */
  storagePath: string;
  pincode?: string;
  bind?: string[];
  firmwareRevision?: string;
}

interface BridgeIdentity {
  username: string;
  pincode: string;
  setupID: string;
}

interface Exposed {
  accessory: HapAccessory;
  /** endpointId -> bindings to refresh when that endpoint changes */
  bindings: Map<number, { characteristic: HapCharacteristic; binding: CharacteristicBinding }[]>;
  signature: string;
}

/**
 * Exposes Livynq devices to Apple Home through a HAP bridge.
 * Accessory UUIDs derive from device ids, and HAP-NodeJS persists AID/IID assignments per UUID
 * in `storagePath`, so Apple Home rooms, scenes and automations survive restarts and re-adds.
 */
export class HomeKitExporter implements Exporter {
  readonly id = 'homekit';
  readonly #options: HomeKitExporterOptions;
  #home!: Home;
  #log!: Logger;
  #bridge: InstanceType<typeof Bridge> | undefined;
  #identity!: BridgeIdentity;
  readonly #exposed = new Map<DeviceId, Exposed>();
  readonly #offs: (() => void)[] = [];
  readonly #pending = new Map<string, { timer: NodeJS.Timeout | undefined; values: Record<string, string | number | boolean>; resolvers: { resolve: () => void; reject: (e: unknown) => void }[] }>();
  #paired = false;

  constructor(options: HomeKitExporterOptions) {
    this.#options = options;
  }

  async start(home: Home): Promise<void> {
    this.#home = home;
    this.#log = home.log.child({ exporter: 'homekit' });
    mkdirSync(this.#options.storagePath, { recursive: true, mode: 0o700 });
    setHapStoragePath(this.#options.storagePath);
    this.#identity = this.#loadIdentity();

    const bridge = new Bridge(this.#options.name, uuid.generate(`livynq:bridge:${this.#identity.username}`));
    // Keep AIDs/IIDs of accessories that are temporarily gone (hidden, adapter down, removed) so they
    // come back with the same ids and Apple Home keeps their rooms, scenes and automations.
    bridge.shouldPurgeUnusedIDs = false;
    bridge
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Livynq')
      .setCharacteristic(Characteristic.Model, 'Livynq Bridge')
      .setCharacteristic(Characteristic.SerialNumber, this.#identity.username)
      .setCharacteristic(Characteristic.FirmwareRevision, this.#options.firmwareRevision ?? '0.1.0');
    bridge.on('paired', () => {
      this.#paired = true;
      this.#log.info('paired with Apple Home');
    });
    bridge.on('unpaired', () => {
      this.#paired = false;
      this.#log.info('unpaired from Apple Home');
    });
    this.#bridge = bridge;

    // Publish persisted devices right away; adapters fill in state as they come up.
    for (const device of home.registry.listDevices()) this.#sync(device, true);
    this.#offs.push(
      home.bus.on('device.added', (d) => this.#sync(d)),
      home.bus.on('device.updated', (d) => this.#sync(d)),
      home.bus.on('device.removed', ({ id }) => this.#remove(id)),
      home.bus.on('state', (c) => this.#refresh(c.deviceId, c.endpointId)),
      home.bus.on('availability', ({ deviceId }) => this.#refreshAll(deviceId)),
    );

    await bridge.publish({
      username: this.#identity.username,
      pincode: this.#identity.pincode,
      setupID: this.#identity.setupID,
      port: this.#options.port,
      category: CATEGORY_BRIDGE,
      bind: this.#options.bind,
      advertiser: 'ciao' as never,
    });
    this.#paired = (bridge._accessoryInfo?.listPairings().length ?? 0) > 0;
    this.#log.info({ port: this.#options.port, pincode: this.#identity.pincode, accessories: this.#exposed.size, paired: this.#paired }, 'HomeKit bridge published');
  }

  async stop(): Promise<void> {
    for (const off of this.#offs.splice(0)) off();
    for (const p of this.#pending.values()) clearTimeout(p.timer);
    await this.#bridge?.unpublish();
    this.#bridge = undefined;
  }

  bridges(): HomeKitBridgeInfo[] {
    if (!this.#bridge) return [];
    return [
      {
        id: 'main',
        name: this.#options.name,
        pincode: this.#identity.pincode,
        setupURI: this.#bridge.setupURI(),
        port: this.#options.port,
        paired: this.#paired,
        accessoryCount: this.#exposed.size,
      },
    ];
  }

  /** HAP accessory ids per device: diagnostics, and the stability guarantee tests rely on. */
  accessoryIds(): Record<DeviceId, number | undefined> {
    return Object.fromEntries([...this.#exposed].map(([id, e]) => [id, e.accessory.aid ?? undefined]));
  }

  #loadIdentity(): BridgeIdentity {
    const file = join(this.#options.storagePath, 'bridge.json');
    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as BridgeIdentity;
      return { ...stored, pincode: this.#options.pincode ?? stored.pincode };
    }
    const identity: BridgeIdentity = {
      username: [...randomBytes(6)].map((b, i) => (i === 0 ? (b & 0xfc) | 0x02 : b).toString(16).padStart(2, '0').toUpperCase()).join(':'),
      pincode: this.#options.pincode ?? generatePincode(),
      setupID: [...randomBytes(4)].map((b) => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[b % 36]).join(''),
    };
    writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
    return identity;
  }

  // ---------------------------------------------------------------- accessories

  #sync(device: Device, initial = false): void {
    const bridge = this.#bridge;
    if (!bridge) return;
    const plans = device.exposure.homekit ? servicesFor(device) : [];
    if (!plans.length) return this.#remove(device.id);

    const signature = JSON.stringify(plans.map((p) => [p.key, p.service, p.characteristics.map((c) => c.name)]));
    const existing = this.#exposed.get(device.id);
    if (existing && existing.signature === signature) {
      existing.accessory.getService(Service.AccessoryInformation)?.updateCharacteristic(Characteristic.Name, device.name);
      return this.#refreshAll(device.id);
    }
    if (existing) this.#remove(device.id);
    if (this.#exposed.size >= MAX_BRIDGED) {
      this.#log.warn({ device: device.id }, `bridge is full (${MAX_BRIDGED} accessories); device not exposed`);
      return;
    }

    const accessory = new Accessory(device.name, uuid.generate(`livynq:device:${device.id}`));
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, device.info.manufacturer || 'Livynq')
      .setCharacteristic(Characteristic.Model, device.info.model || device.protocol)
      .setCharacteristic(Characteristic.SerialNumber, device.info.serial || device.id)
      .setCharacteristic(Characteristic.FirmwareRevision, sanitizeVersion(device.info.firmware));

    const bindings = new Map<number, { characteristic: HapCharacteristic; binding: CharacteristicBinding }[]>();
    for (const plan of plans) {
      const service = this.#createService(device, plan, accessory);
      for (const binding of plan.characteristics) {
        const characteristic = service.getCharacteristic((Characteristic as unknown as Record<string, never>)[binding.name]!);
        if (binding.props) characteristic.setProps(binding.props);
        characteristic.onGet(() => this.#read(device.id, plan.endpointId, binding));
        if (binding.write) {
          const write = binding.write;
          characteristic.onSet((value) => this.#write(device.id, plan.endpointId, binding.name, value, write));
        }
        const list = bindings.get(plan.endpointId) ?? [];
        list.push({ characteristic, binding });
        bindings.set(plan.endpointId, list);
      }
    }
    this.#exposed.set(device.id, { accessory, bindings, signature });
    bridge.addBridgedAccessory(accessory, initial);
    this.#refreshAll(device.id);
  }

  #createService(device: Device, plan: ServicePlan, accessory: HapAccessory): HapService {
    const ServiceType = (Service as unknown as Record<string, typeof HapService>)[plan.service]!;
    const name = plan.name ? `${device.name} ${plan.name}` : device.name;
    const service = accessory.addService(ServiceType, name, plan.key);
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    return service;
  }

  #remove(id: DeviceId): void {
    const exposed = this.#exposed.get(id);
    if (!exposed) return;
    this.#exposed.delete(id);
    this.#bridge?.removeBridgedAccessory(exposed.accessory);
  }

  #read(deviceId: DeviceId, endpointId: number, binding: CharacteristicBinding): CharacteristicValue {
    const device = this.#home.registry.getDevice(deviceId);
    if (!device || device.availability === 'offline') throw new HapStatusError(COMMUNICATION_FAILURE);
    return binding.read(this.#home.registry.getState(deviceId)[endpointId] ?? {});
  }

  #refresh(deviceId: DeviceId, endpointId: number): void {
    const exposed = this.#exposed.get(deviceId);
    const device = this.#home.registry.getDevice(deviceId);
    if (!exposed || !device) return;
    const state = this.#home.registry.getState(deviceId)[endpointId] ?? {};
    for (const { characteristic, binding } of exposed.bindings.get(endpointId) ?? []) {
      characteristic.updateValue(device.availability === 'offline' ? new HapStatusError(COMMUNICATION_FAILURE) : binding.read(state));
    }
  }

  #refreshAll(deviceId: DeviceId): void {
    for (const endpointId of this.#exposed.get(deviceId)?.bindings.keys() ?? []) this.#refresh(deviceId, endpointId);
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
