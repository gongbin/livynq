/** Wire types shared by the server, the web UI, the CLI and the MCP tools. */
import type { Availability, Device, DeviceState, Level, Room } from './device.ts';

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

/** `GET /api/v1/matter`: the Matter bridge that shares Livynq devices with other ecosystems. */
export interface MatterBridgeInfo {
  enabled: boolean;
  commissioned: boolean;
  /** "MT:…" payload for the pairing QR code (null when the bridge is off) */
  qrPairingCode: string | null;
  manualPairingCode: string | null;
  port: number;
  /** Controllers (ecosystems) that added the bridge */
  fabrics: { label: string; vendorId: number }[];
  deviceCount: number;
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
  | { type: 'snapshot'; devices: DeviceDTO[]; rooms: Room[]; levels: Level[] }
  | { type: 'device'; device: DeviceDTO }
  | { type: 'device.removed'; id: string }
  | { type: 'state'; deviceId: string; endpointId: number; capability: string; attribute: string; value: unknown; source: string; ts: number }
  | { type: 'availability'; deviceId: string; availability: Availability }
  | { type: 'rooms'; rooms: Room[] }
  | { type: 'confirmation'; confirmation: ConfirmationDTO }
  | { type: 'settings'; wall: WallSettings }
  | { type: 'levels'; levels: Level[] }
  | { type: 'notification'; notification: NotificationDTO }
  | { type: 'result'; id: number; ok: true }
  | { type: 'result'; id: number; ok: false; error: ApiErrorBody['error'] };

/** A message for people (automation notify.notify, approval requests). */
export interface NotificationDTO {
  id: string;
  title?: string;
  message: string;
  url?: string;
  tag?: string;
  kind: 'message' | 'confirmation';
  source: string;
  ts: number;
}

/** `GET /api/v1/push`: Web Push setup for this hub. */
export interface PushInfo {
  /** VAPID application server key (base64url) for PushManager.subscribe */
  publicKey: string;
  /** Devices subscribed with the calling token */
  subscriptions: { endpoint: string; name: string; createdAt: number; lastError?: string }[];
}

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
