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
  | { type: 'confirmation'; confirmation: ConfirmationDTO }
  | { type: 'settings'; wall: WallSettings }
  | { type: 'result'; id: number; ok: true }
  | { type: 'result'; id: number; ok: false; error: ApiErrorBody['error'] };

export type WsClientMessage = { type: 'command'; id: number; deviceId: string; endpointId: number } & CommandBody;

export interface ConfirmationDTO {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'executed' | 'denied' | 'expired' | 'failed';
  requestedBy: string;
  request: { deviceId: string; endpointId: number; capability: string; command: string; params?: Record<string, unknown> };
  risk: 'low' | 'medium' | 'high';
  summary: string;
  decidedBy: string | null;
  decidedAt: number | null;
  error: string | null;
}

/** Look of the wall panel (kiosk) mode, shared by all tablets. */
export interface WallSettings {
  /** Uploaded image; `url` already includes a cache-busting version. */
  background: { contentType: string; updatedAt: number; url: string } | null;
  /** 0.2..1: card background opacity over the image. */
  cardOpacity: number;
  /** Background blur in px (0..40). */
  backgroundBlur: number;
  /** 0..0.9: dark overlay to keep text readable. */
  backgroundDim: number;
}
