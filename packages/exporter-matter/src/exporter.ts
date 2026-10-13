import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { Endpoint, Environment, Logger, ServerNode, VendorId } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import {
  ColorTemperatureLightDevice,
  ContactSensorDevice,
  DimmableLightDevice,
  DoorLockDevice,
  ExtendedColorLightDevice,
  FanDevice,
  HumiditySensorDevice,
  LightSensorDevice,
  OccupancySensorDevice,
  OnOffLightDevice,
  OnOffPlugInUnitDevice,
  TemperatureSensorDevice,
  ThermostatDevice,
  WaterLeakDetectorDevice,
  WindowCoveringDevice,
} from '@matter/main/devices';
import { ColorControlServer } from '@matter/main/behaviors/color-control';
import { DoorLockServer } from '@matter/main/behaviors/door-lock';
import { OccupancySensingServer } from '@matter/main/behaviors/occupancy-sensing';
import { ThermostatServer } from '@matter/main/behaviors/thermostat';
import { WindowCoveringServer, MovementType, MovementDirection } from '@matter/main/behaviors/window-covering';
import { LivynqError, type Exporter, type Home, type Logger as LivynqLogger } from '@livynq/core';
import type { AttributeValue, Device, DeviceId } from '@livynq/model';
import { degreesToHue } from '@livynq/model';

export interface MatterExporterOptions {
  /** Directory for the Matter node's fabric credentials and endpoint numbers. Must be backed up. */
  storagePath: string;
  port?: number;
  passcode?: number;
  discriminator?: number;
  name?: string;
  /** Limit Matter mDNS to one network interface (hosts with VPN / Docker interfaces). */
  networkInterface?: string;
  /** Tests: also forward changes made through local (offline) contexts. */
  forwardLocalChanges?: boolean;
}

export interface MatterBridgeInfo {
  enabled: boolean;
  commissioned: boolean;
  qrPairingCode: string | null;
  manualPairingCode: string | null;
  port: number;
  fabrics: { label: string; vendorId: number }[];
  deviceCount: number;
}

type Route = { deviceId: DeviceId; endpointId: number };

/** endpoint id (matter.js) → Livynq endpoint; behaviors use it to route controller commands. */
const routes = new Map<string, Route & { exporter: MatterExporter }>();

// ColorControl.ColorMode: 0 = hue/saturation, 1 = xy, 2 = color temperature
const ColorMode = { HS: 0, XY: 1, CT: 2 };
// Thermostat.SystemMode
const SystemMode: Record<string, number> = { off: 0, auto: 1, cool: 3, heat: 4, fan_only: 7, dry: 8 };
const SystemModeName = Object.fromEntries(Object.entries(SystemMode).map(([k, v]) => [v, k])) as Record<number, string>;
// FanControl.FanMode
const FanMode: Record<string, number> = { off: 0, low: 1, medium: 2, high: 3, on: 4, auto: 5 };

class LivynqWindowCoveringServer extends WindowCoveringServer.with('Lift', 'PositionAwareLift') {
  override async handleMovement(type: MovementType, _reversed: boolean, direction: MovementDirection, targetPercent100ths?: number) {
    if (type !== MovementType.Lift) return;
    const route = routes.get(this.endpoint.id);
    if (!route) return;
    // Matter: 0 % = fully open (percent closed). Livynq: 100 = fully open.
    if (targetPercent100ths !== undefined) await route.exporter.forward(route, 'windowCovering', 'goToPosition', { position: Math.round(100 - targetPercent100ths / 100) });
    else await route.exporter.forward(route, 'windowCovering', direction === MovementDirection.Close ? 'close' : 'open', {});
  }

  override async handleStopMovement() {
    const route = routes.get(this.endpoint.id);
    if (route) await route.exporter.forward(route, 'windowCovering', 'stop', {});
  }
}

class LivynqDoorLockServer extends DoorLockServer {
  override async lockDoor() {
    const route = routes.get(this.endpoint.id);
    if (route) await route.exporter.forward(route, 'doorLock', 'lock', {});
  }

  override async unlockDoor() {
    const route = routes.get(this.endpoint.id);
    if (route) await route.exporter.forward(route, 'doorLock', 'unlock', {});
  }
}

/**
 * Exposes Livynq devices as a Matter bridge (aggregator with bridged nodes), so Apple Home,
 * Google Home, Alexa and SmartThings can all control them through one pairing (multi-admin).
 * Controller writes are forwarded as Livynq commands; Livynq state is written back into Matter.
 */
export class MatterExporter implements Exporter {
  readonly id = 'matter';
  readonly #options: MatterExporterOptions;
  #home!: Home;
  #log!: LivynqLogger;
  #server: ServerNode | undefined;
  #aggregator: Endpoint | undefined;
  readonly #endpoints = new Map<string, { endpoint: Endpoint; signature: string; route: Route }>();
  /** Matter endpoints currently receiving Livynq state: their change events are not commands. */
  readonly #applying = new Map<string, number>();
  readonly #offs: (() => void)[] = [];
  /** matter.js endpoint changes are serialised: concurrent syncs of one device would add an endpoint twice. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: MatterExporterOptions) {
    this.#options = options;
  }

  async start(home: Home): Promise<void> {
    this.#home = home;
    this.#log = home.log.child({ exporter: 'matter' });
    mkdirSync(this.#options.storagePath, { recursive: true, mode: 0o700 });
    Logger.level = 'warn';
    const environment = Environment.default;
    environment.vars.set('storage.path', this.#options.storagePath);
    const networkInterface = this.#options.networkInterface ?? process.env.MATTER_MDNS_NETWORKINTERFACE ?? defaultMatterInterface();
    if (networkInterface) environment.vars.set('mdns.networkInterface', networkInterface);
    const name = this.#options.name ?? 'Livynq Bridge';
    this.#server = await ServerNode.create({
      id: 'livynq-bridge',
      environment,
      network: { port: this.#options.port ?? 5540 },
      commissioning: { passcode: this.#options.passcode ?? 20202021, discriminator: this.#options.discriminator ?? 3840 },
      productDescription: { name, deviceType: AggregatorEndpoint.deviceType },
      basicInformation: {
        vendorName: 'Livynq',
        vendorId: VendorId(0xfff1),
        productName: name,
        productLabel: 'Bridge',
        nodeLabel: name,
        productId: 0x8000,
        serialNumber: 'LIVYNQ-0001',
        uniqueId: 'livynq-bridge',
        hardwareVersion: 1,
        softwareVersion: 1,
      },
    });
    this.#aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await this.#server.add(this.#aggregator);
    for (const device of home.registry.listDevices()) await this.#sync(device);
    const latest = (id: DeviceId) => home.registry.getDevice(id);
    this.#offs.push(
      home.bus.on('device.added', (d) => this.#enqueue(() => this.#sync(latest(d.id) ?? d))),
      home.bus.on('device.updated', (d) => this.#enqueue(() => this.#sync(latest(d.id) ?? d))),
      home.bus.on('device.removed', ({ id }) => this.#enqueue(() => this.#removeDevice(id))),
      home.bus.on('state', (c) => {
        // Layout-relevant attributes (supported modes, color temperature range) rebuild the endpoint.
        if (c.attribute === 'supportedModes' || c.attribute === 'colorTempPhysicalMinMireds' || c.attribute === 'colorTempPhysicalMaxMireds') {
          return this.#enqueue(async () => {
            const device = latest(c.deviceId);
            if (device) await this.#sync(device);
          });
        }
        this.#enqueue(() => this.#apply(c.deviceId, c.endpointId));
      }),
      home.bus.on('availability', ({ deviceId }) => this.#enqueue(() => this.#applyAll(deviceId))),
    );
    await this.#server.start();
    const info = this.info();
    this.#log.info({ port: info.port, commissioned: info.commissioned, manualPairingCode: info.manualPairingCode, devices: info.deviceCount }, 'Matter bridge started');
  }

  async stop(): Promise<void> {
    for (const off of this.#offs.splice(0)) off();
    for (const [id] of this.#endpoints) routes.delete(id);
    await this.#server?.close();
    this.#server = undefined;
  }

  info(): MatterBridgeInfo {
    const server = this.#server;
    const commissioning = server?.state.commissioning;
    return {
      enabled: Boolean(server),
      commissioned: Boolean(commissioning?.commissioned),
      qrPairingCode: commissioning?.pairingCodes.qrPairingCode ?? null,
      manualPairingCode: commissioning?.pairingCodes.manualPairingCode ?? null,
      port: this.#options.port ?? 5540,
      fabrics: Object.values(commissioning?.fabrics ?? {}).map((f) => ({ label: String((f as { label?: string }).label ?? ''), vendorId: Number((f as { rootVendorId?: number }).rootVendorId ?? 0) })),
      deviceCount: this.#endpoints.size,
    };
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch((err: unknown) => this.#log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Matter update failed'));
  }

  /** Resolves once queued Matter updates are applied (tests). */
  async settled(): Promise<void> {
    await this.#queue;
  }

  /** The matter.js endpoint of a Livynq endpoint (diagnostics, tests). */
  endpoint(deviceId: DeviceId, endpointId: number): Endpoint | undefined {
    return this.#endpoints.get(MatterExporter.endpointId(deviceId, endpointId))?.endpoint;
  }

  /** Called by behaviors / change listeners: a controller asked for something. */
  async forward(route: Route, capability: string, command: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.#home.command({ ...route, capability, command, params }, 'matter');
    } catch (err) {
      this.#log.warn({ ...route, capability, command, err: err instanceof LivynqError ? err.message : String(err) }, 'Matter command failed');
      throw err;
    }
  }

  // ---------------------------------------------------------------- endpoints

  static endpointId(deviceId: DeviceId, endpointId: number): string {
    // matter.js endpoint ids are persisted and must stay stable; dots are not allowed.
    return `d${createHash('sha1').update(`${deviceId}#${endpointId}`).digest('hex').slice(0, 16)}`;
  }

  async #sync(device: Device): Promise<void> {
    const wanted = device.exposure.matter !== false ? device.endpoints : [];
    const keep = new Set<string>();
    for (const ep of wanted) {
      const type = this.#typeFor(device, ep.id);
      if (!type) continue;
      const id = MatterExporter.endpointId(device.id, ep.id);
      keep.add(id);
      const signature = JSON.stringify([ep.deviceType, ep.capabilities, type.signature]);
      const existing = this.#endpoints.get(id);
      if (existing?.signature === signature) {
        await this.#setGuarded(existing.endpoint, { bridgedDeviceBasicInformation: { nodeLabel: label(device, ep.name) } });
        continue;
      }
      if (existing) await this.#remove(id);
      const route = { deviceId: device.id, endpointId: ep.id };
      routes.set(id, { ...route, exporter: this });
      const endpoint = new Endpoint(type.type.with(BridgedDeviceBasicInformationServer), {
        id,
        bridgedDeviceBasicInformation: {
          nodeLabel: label(device, ep.name),
          productName: (device.info.model ?? device.protocol).slice(0, 32),
          vendorName: (device.info.manufacturer ?? 'Livynq').slice(0, 32),
          serialNumber: (device.info.serial ?? device.id).slice(0, 32),
          uniqueId: id,
          reachable: device.availability !== 'offline',
        },
        ...type.initial,
      });
      try {
        await this.#aggregator!.add(endpoint);
      } catch (err) {
        routes.delete(id);
        this.#log.warn({ device: device.id, endpoint: ep.id, err: (err as Error).message }, 'could not expose endpoint over Matter');
        continue;
      }
      this.#endpoints.set(id, { endpoint, signature, route });
      this.#listen(endpoint, route);
      await this.#apply(device.id, ep.id);
    }
    for (const [id, e] of [...this.#endpoints]) if (e.route.deviceId === device.id && !keep.has(id)) await this.#remove(id);
  }

  async #remove(id: string): Promise<void> {
    const e = this.#endpoints.get(id);
    if (!e) return;
    this.#endpoints.delete(id);
    routes.delete(id);
    await e.endpoint.close();
  }

  async #removeDevice(deviceId: DeviceId): Promise<void> {
    for (const [id, e] of [...this.#endpoints]) if (e.route.deviceId === deviceId) await this.#remove(id);
  }

  /** matter.js device type + initial cluster state for a Livynq endpoint, or undefined if not bridgeable. */
  #typeFor(device: Device, endpointId: number): { type: typeof OnOffLightDevice; initial: Record<string, unknown>; signature: string } | undefined {
    const ep = device.endpoints.find((e) => e.id === endpointId)!;
    const s = this.#home.registry.getState(device.id)[endpointId] ?? {};
    const any = (t: unknown, initial: Record<string, unknown> = {}, signature = '') => ({ type: t as typeof OnOffLightDevice, initial, signature });
    switch (ep.deviceType) {
      case 'light.onOff':
        return any(OnOffLightDevice);
      case 'light.dimmable':
        return any(DimmableLightDevice);
      case 'light.colorTemperature': {
        const min = num(s.colorControl?.colorTempPhysicalMinMireds, 153);
        const max = num(s.colorControl?.colorTempPhysicalMaxMireds, 500);
        return any(ColorTemperatureLightDevice, { colorControl: { colorTempPhysicalMinMireds: min, colorTempPhysicalMaxMireds: max, coupleColorTempToLevelMinMireds: min, startUpColorTemperatureMireds: null } }, `${min}-${max}`);
      }
      case 'light.extendedColor': {
        const min = num(s.colorControl?.colorTempPhysicalMinMireds, 153);
        const max = num(s.colorControl?.colorTempPhysicalMaxMireds, 500);
        return any(ExtendedColorLightDevice.with(ColorControlServer.with('HueSaturation', 'Xy', 'ColorTemperature')), {
          colorControl: {
            colorTempPhysicalMinMireds: min,
            colorTempPhysicalMaxMireds: max,
            coupleColorTempToLevelMinMireds: min,
            startUpColorTemperatureMireds: null,
            colorMode: ColorMode.CT,
            enhancedColorMode: ColorMode.CT,
          },
        }, `${min}-${max}`);
      }
      case 'plug.onOff':
      case 'switch.onOff':
        return any(OnOffPlugInUnitDevice);
      case 'sensor.temperature':
        return any(TemperatureSensorDevice, { temperatureMeasurement: { minMeasuredValue: -5000, maxMeasuredValue: 10000 } });
      case 'sensor.humidity':
        return any(HumiditySensorDevice, { relativeHumidityMeasurement: { minMeasuredValue: 0, maxMeasuredValue: 10000 } });
      case 'sensor.light':
        return any(LightSensorDevice, { illuminanceMeasurement: { minMeasuredValue: 1, maxMeasuredValue: 0xfffe } });
      case 'binarySensor.occupancy':
        return any(OccupancySensorDevice.with(OccupancySensingServer.with('PassiveInfrared')), { occupancySensing: { occupancySensorType: 0, occupancySensorTypeBitmap: { pir: true, ultrasonic: false, physicalContact: false } } });
      case 'binarySensor.contact':
        return any(ContactSensorDevice);
      case 'binarySensor.leak':
        return any(WaterLeakDetectorDevice);
      case 'cover.window':
        return any(WindowCoveringDevice.with(LivynqWindowCoveringServer), { windowCovering: { type: 0, endProductType: 0 } });
      case 'climate.thermostat':
      case 'climate.airConditioner': {
        const modes = String(s.thermostat?.supportedModes ?? 'off,heat').split(',');
        const heat = modes.includes('heat') || modes.includes('auto');
        const cool = modes.includes('cool') || modes.includes('auto');
        const features = [...(heat ? ['Heating'] : []), ...(cool ? ['Cooling'] : [])] as ('Heating' | 'Cooling')[];
        if (!features.length) return undefined;
        // controlSequenceOfOperation: 0 cooling only, 2 heating only, 4 cooling and heating
        return any(ThermostatDevice.with(ThermostatServer.with(...features)), {
          thermostat: {
            controlSequenceOfOperation: heat && cool ? 4 : heat ? 2 : 0,
            // "auto" needs the AutoMode feature; start in a mode the feature set allows.
            systemMode: heat ? SystemMode.heat : SystemMode.cool,
            ...(heat ? { minHeatSetpointLimit: 700, maxHeatSetpointLimit: 3000, absMinHeatSetpointLimit: 700, absMaxHeatSetpointLimit: 3000 } : {}),
            ...(cool ? { minCoolSetpointLimit: 1600, maxCoolSetpointLimit: 3200, absMinCoolSetpointLimit: 1600, absMaxCoolSetpointLimit: 3200 } : {}),
          },
        }, features.join());
      }
      case 'fan.fan':
        // fanModeSequence 0 = Off/Low/Med/High (Auto would need the Auto feature)
        return any(FanDevice, { fanControl: { fanModeSequence: 0, fanMode: 0, percentSetting: 0, percentCurrent: 0 } });
      case 'lock.door':
        return any(DoorLockDevice.with(LivynqDoorLockServer), {
          doorLock: {
            lockType: 0,
            actuatorEnabled: true,
            lockState: 1,
            operatingMode: 0, // normal
            wrongCodeEntryLimit: 3,
            userCodeTemporaryDisableTime: 10,
            // inverted bitmap: false = supported
            supportedOperatingModes: { normal: false, vacation: true, privacy: true, noRemoteLockUnlock: false, passage: true, alwaysSet: 2047 },
          },
        });
      default:
        return undefined; // buttons, batteries, power sensors, garage doors: not bridged over Matter yet
    }
  }

  // ---------------------------------------------------------------- controller → Livynq

  #listen(endpoint: Endpoint, route: Route): void {
    const ev = endpoint.events as unknown as Record<string, Record<string, { on(fn: (value: unknown, old: unknown, context: { offline?: boolean }) => void): void }>>;
    const fromController = (context: { offline?: boolean } | undefined) => !this.#applying.get(endpoint.id) && (this.#options.forwardLocalChanges || !context?.offline);
    const on = (cluster: string, attribute: string, fn: (value: unknown) => Promise<void> | void) => {
      ev[cluster]?.[`${attribute}$Changed`]?.on((value, _old, context) => {
        if (!fromController(context)) return;
        void Promise.resolve(fn(value)).catch(() => {});
      });
    };
    on('onOff', 'onOff', (v) => this.forward(route, 'onOff', v ? 'on' : 'off', {}));
    on('levelControl', 'currentLevel', (v) => (typeof v === 'number' && v > 0 ? this.forward(route, 'levelControl', 'moveToLevel', { level: Math.max(1, Math.min(254, v)) }) : undefined));
    on('colorControl', 'colorTemperatureMireds', (v) => this.forward(route, 'colorControl', 'moveToColorTemperature', { colorTemperatureMireds: Number(v) }));
    const hs = () => {
      const c = (endpoint.state as unknown as Record<string, Record<string, number>>).colorControl!;
      return this.forward(route, 'colorControl', 'moveToHueAndSaturation', { hue: c.currentHue ?? 0, saturation: c.currentSaturation ?? 0 });
    };
    on('colorControl', 'currentHue', hs);
    on('colorControl', 'currentSaturation', hs);
    const xy = () => {
      const c = (endpoint.state as unknown as Record<string, Record<string, number>>).colorControl!;
      const { h, s } = xyToHs((c.currentX ?? 0) / 65536, (c.currentY ?? 0) / 65536);
      return this.forward(route, 'colorControl', 'moveToHueAndSaturation', { hue: degreesToHue(h), saturation: Math.round((s / 100) * 254) });
    };
    on('colorControl', 'currentX', xy);
    on('colorControl', 'currentY', xy);
    on('thermostat', 'systemMode', (v) => {
      const mode = SystemModeName[Number(v)];
      return mode ? this.forward(route, 'thermostat', 'setSystemMode', { mode }) : undefined;
    });
    on('thermostat', 'occupiedHeatingSetpoint', (v) => this.forward(route, 'thermostat', 'setTargetTemperature', { temperature: Number(v) / 100 }));
    on('thermostat', 'occupiedCoolingSetpoint', (v) => this.forward(route, 'thermostat', 'setTargetTemperature', { temperature: Number(v) / 100 }));
    on('fanControl', 'percentSetting', (v) => (v === null ? undefined : Number(v) <= 0 ? this.forward(route, 'onOff', 'off', {}) : this.forward(route, 'fanControl', 'setPercent', { percent: Number(v) })));
    on('fanControl', 'fanMode', (v) => {
      const mode = Object.entries(FanMode).find(([, n]) => n === Number(v))?.[0];
      if (mode === 'off') return this.forward(route, 'onOff', 'off', {});
      return mode ? this.forward(route, 'fanControl', 'setMode', { mode }) : undefined;
    });
  }

  // ---------------------------------------------------------------- Livynq → controller

  async #applyAll(deviceId: DeviceId): Promise<void> {
    for (const e of this.#endpoints.values()) if (e.route.deviceId === deviceId) await this.#apply(deviceId, e.route.endpointId);
  }

  async #setGuarded(endpoint: Endpoint, values: Record<string, unknown>): Promise<void> {
    this.#applying.set(endpoint.id, (this.#applying.get(endpoint.id) ?? 0) + 1);
    try {
      await endpoint.set(values as never);
    } catch (err) {
      this.#log.debug({ endpoint: endpoint.id, err: (err as Error).message }, 'Matter state update rejected');
    } finally {
      this.#applying.set(endpoint.id, (this.#applying.get(endpoint.id) ?? 1) - 1);
    }
  }

  async #apply(deviceId: DeviceId, endpointId: number): Promise<void> {
    const entry = this.#endpoints.get(MatterExporter.endpointId(deviceId, endpointId));
    const device = this.#home.registry.getDevice(deviceId);
    if (!entry || !device) return;
    const s = this.#home.registry.getState(deviceId)[endpointId] ?? {};
    const values: Record<string, Record<string, unknown>> = {
      bridgedDeviceBasicInformation: { reachable: device.availability !== 'offline' },
    };
    const set = (cluster: string, attrs: Record<string, unknown>) => {
      const clean = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length && entry.endpoint.behaviors.has(clusterBehavior(entry.endpoint, cluster))) values[cluster] = clean;
    };
    const ep = device.endpoints.find((e) => e.id === endpointId)!;
    if (s.onOff?.onOff !== undefined && ep.deviceType !== 'fan.fan') set('onOff', { onOff: Boolean(s.onOff.onOff) });
    if (s.levelControl?.currentLevel !== undefined) set('levelControl', { currentLevel: num(s.levelControl.currentLevel, 254) });
    if (s.colorControl) {
      const c = s.colorControl;
      const mode = c.colorMode === 'ct' ? ColorMode.CT : c.colorMode === 'hs' ? ColorMode.HS : undefined;
      set('colorControl', {
        colorTemperatureMireds: c.colorTemperatureMireds !== undefined ? num(c.colorTemperatureMireds, 300) : undefined,
        ...(ep.deviceType === 'light.extendedColor' ? { currentHue: opt(c.currentHue), currentSaturation: opt(c.currentSaturation) } : {}),
        ...(mode !== undefined ? { colorMode: mode, enhancedColorMode: mode } : {}),
      });
    }
    if (s.temperatureMeasurement?.measuredValue !== undefined) set('temperatureMeasurement', { measuredValue: Math.round(num(s.temperatureMeasurement.measuredValue, 0) * 100) });
    if (s.relativeHumidityMeasurement?.measuredValue !== undefined) set('relativeHumidityMeasurement', { measuredValue: Math.round(num(s.relativeHumidityMeasurement.measuredValue, 0) * 100) });
    if (s.illuminanceMeasurement?.measuredValue !== undefined) {
      const lux = num(s.illuminanceMeasurement.measuredValue, 0);
      set('illuminanceMeasurement', { measuredValue: lux <= 0 ? 0 : Math.min(0xfffe, Math.round(10000 * Math.log10(lux) + 1)) });
    }
    if (s.occupancySensing?.occupied !== undefined) set('occupancySensing', { occupancy: { occupied: Boolean(s.occupancySensing.occupied) } });
    if (s.booleanState?.stateValue !== undefined) set('booleanState', { stateValue: Boolean(s.booleanState.stateValue) });
    if (s.windowCovering) {
      const w = s.windowCovering;
      const closed = (pos: AttributeValue | undefined) => (pos === undefined ? undefined : Math.round((100 - num(pos, 0)) * 100));
      const moving = w.operationalStatus === 'opening' ? 1 : w.operationalStatus === 'closing' ? 2 : 0;
      set('windowCovering', {
        currentPositionLiftPercent100ths: closed(w.currentPosition),
        targetPositionLiftPercent100ths: closed(w.targetPosition ?? w.currentPosition),
        operationalStatus: { global: moving, lift: moving, tilt: 0 },
      });
    }
    if (s.thermostat) {
      const t = s.thermostat;
      const target = t.targetTemperature !== undefined ? Math.round(num(t.targetTemperature, 21) * 100) : undefined;
      const behaviorState = (entry.endpoint.state as unknown as Record<string, Record<string, unknown>>).thermostat ?? {};
      const canHeat = 'occupiedHeatingSetpoint' in behaviorState;
      const canCool = 'occupiedCoolingSetpoint' in behaviorState;
      const modeAllowed = (m: unknown) => m === 'off' || (m === 'heat' && canHeat) || (m === 'cool' && canCool) || ((m === 'dry' || m === 'fan_only') && canCool);
      set('thermostat', {
        localTemperature: t.localTemperature !== undefined ? Math.round(num(t.localTemperature, 20) * 100) : undefined,
        systemMode: typeof t.systemMode === 'string' && modeAllowed(t.systemMode) ? SystemMode[t.systemMode] : undefined,
        ...('occupiedHeatingSetpoint' in behaviorState ? { occupiedHeatingSetpoint: target === undefined ? undefined : clamp(target, 700, 3000) } : {}),
        ...('occupiedCoolingSetpoint' in behaviorState ? { occupiedCoolingSetpoint: target === undefined ? undefined : clamp(target, 1600, 3200) } : {}),
      });
    }
    if (ep.deviceType === 'fan.fan') {
      const on = Boolean(s.onOff?.onOff);
      const percent = on ? num(s.fanControl?.percentCurrent, 50) : 0;
      set('fanControl', { percentCurrent: percent, percentSetting: percent, fanMode: on ? (FanMode[String(s.fanControl?.fanMode ?? 'on')] ?? 4) : 0 });
    }
    if (s.doorLock?.lockState !== undefined) {
      // LockState: 0 not fully locked, 1 locked, 2 unlocked
      const l = s.doorLock.lockState;
      set('doorLock', { lockState: l === 'locked' ? 1 : l === 'unlocked' ? 2 : 0 });
    }
    await this.#setGuarded(entry.endpoint, values);
  }
}

function clusterBehavior(endpoint: Endpoint, cluster: string): never {
  return (endpoint.behaviors.supported as Record<string, unknown>)[cluster] as never;
}

function label(device: Device, endpointName: string | undefined): string {
  return (endpointName && device.endpoints.length > 1 ? `${device.name} ${endpointName}` : device.name).slice(0, 32);
}

const num = (v: AttributeValue | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const opt = (v: AttributeValue | undefined) => (typeof v === 'number' ? v : undefined);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function xyToHs(x: number, y: number): { h: number; s: number } {
  if (y <= 0) return { h: 0, s: 0 };
  const X = x / y;
  const Z = (1 - x - y) / y;
  let r = X * 1.656492 - 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b, 1e-9);
  [r, g, b] = [r / max, g / max, b / max].map((c) => Math.max(0, c)) as [number, number, number];
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round((((h * 60) % 360) + 360) % 360), s: Math.round((d / mx) * 100) };
}


/**
 * Matter mDNS on every interface makes controllers try VPN/tunnel link-local addresses first
 * (seen on macOS with utun*). Default to the primary LAN interface unless configured.
 */
export function defaultMatterInterface(): string | undefined {
  const skip = /^(lo|utun|awdl|llw|bridge|docker|veth|br-|virbr|vmnet|tun|tap|wg|zt|tailscale|ham)/i;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue;
    if (addrs?.some((a) => a.family === 'IPv4' && !a.internal)) return name;
  }
  return undefined;
}
