import type { AttributeValue, Availability, CameraSource, Device, DeviceDefinition, DeviceId, DeviceState } from '@livynq/model';
import type { Logger } from './logger.ts';
import type { Home } from './home.ts';

export type CommandHandler = (params: Record<string, unknown>) => void | Promise<void>;

/** Protocol adapter: brings external devices into the unified capability model. */
export interface Adapter {
  readonly id: string;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
}

/** Ecosystem exporter (HomeKit, Matter, MQTT...) or internal extension (automation engine...). */
export interface Exporter {
  readonly id: string;
  start(home: Home): Promise<void>;
  stop(): Promise<void>;
}

export interface DeviceHandle {
  readonly id: DeviceId;
  readonly device: Device;
  update(endpointId: number, capability: string, attributes: Record<string, AttributeValue>): void;
  /** Current value as known by the core (last reported or persisted). */
  get(endpointId: number, capability: string, attribute: string): AttributeValue | undefined;
  setAvailability(availability: Availability): void;
  handle(endpointId: number, capability: string, handlers: Record<string, CommandHandler>): void;
}

export interface AdapterContext {
  readonly log: Logger;
  readonly dataDir: string;
  upsertDevice(def: DeviceDefinition): DeviceHandle;
  removeDevice(id: DeviceId): void;
  /** Devices this adapter registered in earlier runs (useful to mark them offline or clean up). */
  knownDevices(): Device[];
  /** Registers a user-invokable operation (see Home.invokeAction). */
  registerAction(name: string, description: string, handler: (params: Record<string, unknown>) => unknown): void;
  /** Whether any adapter (not just this one) has registered the device. */
  deviceExists(id: DeviceId): boolean;
  /** Current state of one of this adapter's devices. */
  deviceState(id: DeviceId): DeviceState;
  /** Stable numeric endpoint id for an adapter specific key. */
  endpointId(deviceId: DeviceId, key: string): number;
  /** Camera stream for one of this adapter's endpoints (memory only; see MediaRegistry). */
  registerMedia(deviceId: DeviceId, endpointId: number, source: CameraSource): void;
  unregisterMedia(deviceId: DeviceId, endpointId: number): void;
}
