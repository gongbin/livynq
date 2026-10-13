/** Wire types shared by the server, the web UI, the CLI and the MCP tools. */
import type { Availability, Device, DeviceState, Room } from './device.ts';

export type TokenScope = 'read' | 'control' | 'admin';

export interface DeviceDTO extends Device {
  roomName: string | null;
  /** endpointId -> entity id */
  entities: Record<number, string>;
  state: DeviceState;
}

export interface SystemInfo {
  name: 'Livynq';
  version: string;
  startedAt: number;
  adapters: string[];
  deviceCount: number;
  homekit: { enabled: boolean };
  mcp: { path: string };
}

export interface HomeKitBridgeInfo {
  id: string;
  name: string;
  pincode: string;
  setupURI: string;
  port: number;
  paired: boolean;
  accessoryCount: number;
}

export interface CommandBody {
  capability: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string };
}

export type WsServerMessage =
  | { type: 'snapshot'; devices: DeviceDTO[]; rooms: Room[] }
  | { type: 'device'; device: DeviceDTO }
  | { type: 'device.removed'; id: string }
  | { type: 'state'; deviceId: string; endpointId: number; capability: string; attribute: string; value: unknown; source: string; ts: number }
  | { type: 'availability'; deviceId: string; availability: Availability }
  | { type: 'rooms'; rooms: Room[] }
  | { type: 'result'; id: number; ok: true }
  | { type: 'result'; id: number; ok: false; error: ApiErrorBody['error'] };

export type WsClientMessage = { type: 'command'; id: number; deviceId: string; endpointId: number } & CommandBody;
