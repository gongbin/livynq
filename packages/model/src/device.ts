import type { CapabilityId } from './capabilities.ts';

export type DeviceId = string;
export type Protocol = 'matter' | 'zigbee' | 'zwave' | 'mqtt' | 'esphome' | 'homekit' | 'ble' | 'lan' | 'ha' | 'virtual';
export type Availability = 'online' | 'offline' | 'unknown';
export type AttributeValue = boolean | number | string | null;

/** Where a device may be exposed. `agent` controls MCP / LLM visibility. */
export interface ExposurePolicy {
  homekit: boolean;
  /** Matter bridge (Google / Alexa / SmartThings / Apple via Matter). Missing means true. */
  matter?: boolean;
  agent: 'visible' | 'readOnly' | 'hidden';
}

export interface EndpointDefinition {
  id: number;
  deviceType: string;
  name?: string;
  capabilities: CapabilityId[];
  /** The device does not report state; the core applies commands optimistically. */
  assumedState?: boolean;
}

export interface DeviceInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  firmware?: string;
}

/** What an adapter reports about a device. */
export interface DeviceDefinition {
  id: DeviceId;
  name: string;
  protocol: Protocol;
  info?: DeviceInfo;
  endpoints: EndpointDefinition[];
  /** Initial room suggestion (e.g. from discovery `suggested_area`); user choice wins. */
  suggestedRoom?: string;
}

export interface Device extends DeviceDefinition {
  adapter: string;
  info: DeviceInfo;
  roomId: string | null;
  aliases: string[];
  availability: Availability;
  exposure: ExposurePolicy;
  /** True once a user has renamed the device; adapter names no longer overwrite it. */
  nameByUser: boolean;
  createdAt: number;
  updatedAt: number;
}

/** state[endpointId][capability][attribute] */
export type DeviceState = Record<number, Record<string, Record<string, AttributeValue>>>;

export interface StateChange {
  deviceId: DeviceId;
  endpointId: number;
  capability: string;
  attribute: string;
  value: AttributeValue;
  oldValue: AttributeValue | undefined;
  ts: number;
  source: string;
}

export interface Room {
  id: string;
  name: string;
  aliases: string[];
  sortOrder: number;
}

export const defaultExposure = (): ExposurePolicy => ({ homekit: true, agent: 'visible' });
