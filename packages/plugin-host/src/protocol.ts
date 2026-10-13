import type { AttributeValue, Availability, Device, DeviceDefinition } from '@livynq/model';

/** IPC between the hub (parent) and a plugin host process (child). Requests carry an id; responses echo it. */

export type ParentMessage =
  | { type: 'start'; module: string; pluginId: string; config: Record<string, unknown>; dataDir: string; state: Record<string, StateSnapshot> }
  | { type: 'invoke'; id: number; deviceId: string; endpointId: number; capability: string; command: string; params: Record<string, unknown> }
  | { type: 'response'; id: number; ok: true; value?: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'stop' };

export type ChildMessage =
  | { type: 'ready' }
  | { type: 'started' }
  | { type: 'startFailed'; error: string }
  | { type: 'request'; id: number; method: 'upsertDevice'; def: DeviceDefinition }
  | { type: 'request'; id: number; method: 'removeDevice'; deviceId: string }
  | { type: 'request'; id: number; method: 'knownDevices' }
  | { type: 'request'; id: number; method: 'endpointId'; deviceId: string; key: string }
  | { type: 'update'; deviceId: string; endpointId: number; capability: string; attributes: Record<string, AttributeValue> }
  | { type: 'availability'; deviceId: string; availability: Availability }
  | { type: 'handle'; deviceId: string; endpointId: number; capability: string; commands: string[] }
  | { type: 'invokeResult'; id: number; ok: true }
  | { type: 'invokeResult'; id: number; ok: false; error: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: Record<string, unknown> }
  | { type: 'stopped' };

/** endpointId -> capability -> attribute -> value */
export type StateSnapshot = Record<number, Record<string, Record<string, AttributeValue>>>;

export type { Device };
