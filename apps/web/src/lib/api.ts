import type {
  ApiErrorBody,
  CommandBody,
  ConfirmationDTO,
  DeviceDTO,
  ExposurePolicy,
  HomeKitBridgeInfo,
  Risk,
  Room,
  SystemInfo,
  TokenScope,
  WallSettings,
} from '@livynq/model';
import { createStore, readLocal, writeLocal } from './store.ts';

const TOKEN_KEY = 'livynq.token';

export interface TokenInfo {
  id: string;
  name: string;
  scope: TokenScope;
  /** Commands above this risk wait for a human approval (older servers may omit it). */
  riskLimit?: Risk;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AuditRow {
  ts: number;
  source: string;
  device_id: string;
  endpoint_id: number;
  capability: string;
  command: string;
  params: Record<string, unknown>;
  ok: boolean;
  error: string | null;
}

export interface HistoryPoint {
  ts: number;
  value: number | boolean | string | null;
}

export interface DevicePatch {
  name?: string;
  roomId?: string | null;
  aliases?: string[];
  exposure?: Partial<ExposurePolicy>;
}

export type RunState = 'running' | 'finished' | 'stopped' | 'error' | 'aborted';

/** Mirrors `AutomationInfo` in packages/automation/src/engine.ts. */
export interface AutomationInfo {
  id: string;
  alias: string;
  description?: string;
  mode: string;
  enabled: boolean;
  valid: boolean;
  errors: string[];
  config: Record<string, unknown>;
  version: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastTriggered: number | null;
  running: number;
}

export interface TraceStep {
  path: string;
  type: string;
  alias?: string;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

export interface Trace {
  runId: string;
  automationId: string;
  startedAt: number;
  finishedAt?: number;
  state: RunState;
  trigger: { description: string; vars: Record<string, unknown> };
  conditions: { path: string; result: boolean }[];
  steps: TraceStep[];
  stopReason?: string;
  error?: string;
}

export interface AutomationVersion {
  version: number;
  source: string;
  createdAt: number;
  config: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Non-blocking, e.g. entity ids that do not exist (yet). */
  warnings?: string[];
}

/** REST 202: the command was queued for a human approval instead of being executed. */
export interface PendingCommand {
  ok: false;
  pending: true;
  confirmation: ConfirmationDTO;
}

export type CommandResult = { ok: true } | PendingCommand;

export type ConfirmationStatus = ConfirmationDTO['status'];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.hint = body.hint;
  }
}

/** The access token; `null` means signed out. Components react to changes (e.g. 401 → login). */
export const auth = createStore<string | null>(readTokenFromUrl() ?? readLocal(TOKEN_KEY));

/**
 * The server prints `http://host:8581/#token=lvq_...`; consume it once and clean the URL.
 * An optional `&next=/automations/x` picks the page to land on (handy for deep links).
 */
function readTokenFromUrl(): string | null {
  const match = /^#token=([^&]+)(?:&next=(.*))?$/.exec(location.hash);
  if (!match?.[1]) return null;
  const token = decodeURIComponent(match[1]);
  const next = match[2] ? decodeURIComponent(match[2]) : '/home';
  writeLocal(TOKEN_KEY, token);
  history.replaceState(null, '', `${location.pathname}${location.search}#${next.startsWith('/') ? next : '/home'}`);
  return token;
}

export function signIn(token: string): void {
  writeLocal(TOKEN_KEY, token);
  auth.set(token);
}

export function signOut(): void {
  writeLocal(TOKEN_KEY, null);
  auth.set(null);
}

async function request<T>(method: string, path: string, body?: unknown, token = auth.get()): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error ?? { code: 'HTTP_' + res.status, message: res.statusText || 'Request failed' };
    // Only drop the session when the token in use is the one that was rejected.
    if (res.status === 401 && token === auth.get()) signOut();
    throw new ApiError(res.status, err);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  /** Validates a token without touching the stored session. */
  me: (token?: string) => request<{ token: TokenInfo }>('GET', '/auth/me', undefined, token ?? auth.get()),
  systemInfo: () => request<SystemInfo>('GET', '/system/info'),

  devices: () => request<DeviceDTO[]>('GET', '/devices'),
  updateDevice: (id: string, patch: DevicePatch) => request<DeviceDTO>('PATCH', `/devices/${enc(id)}`, patch),
  deleteDevice: (id: string) => request<void>('DELETE', `/devices/${enc(id)}`),
  command: (deviceId: string, endpointId: number, body: CommandBody) =>
    request<CommandResult>('POST', `/devices/${enc(deviceId)}/endpoints/${endpointId}/commands`, body),
  history: (deviceId: string, q: { endpoint: number; capability: string; attribute: string; from?: number; to?: number }) => {
    const params = new URLSearchParams({ endpoint: String(q.endpoint), capability: q.capability, attribute: q.attribute });
    if (q.from) params.set('from', String(q.from));
    if (q.to) params.set('to', String(q.to));
    return request<HistoryPoint[]>('GET', `/devices/${enc(deviceId)}/history?${params}`);
  },

  rooms: () => request<Room[]>('GET', '/rooms'),
  createRoom: (name: string) => request<Room>('POST', '/rooms', { name }),
  updateRoom: (id: string, patch: { name?: string; sortOrder?: number }) => request<Room>('PATCH', `/rooms/${enc(id)}`, patch),
  deleteRoom: (id: string) => request<void>('DELETE', `/rooms/${enc(id)}`),

  homekit: () => request<{ enabled: boolean; bridges: HomeKitBridgeInfo[] }>('GET', '/homekit'),

  tokens: () => request<TokenInfo[]>('GET', '/tokens'),
  createToken: (name: string, scope: TokenScope, riskLimit?: Risk) => request<{ token: string; info: TokenInfo }>('POST', '/tokens', { name, scope, riskLimit }),
  revokeToken: (id: string) => request<void>('DELETE', `/tokens/${enc(id)}`),

  automations: () => request<AutomationInfo[]>('GET', '/automations'),
  automation: (id: string) => request<AutomationInfo>('GET', `/automations/${enc(id)}`),
  validateAutomation: (config: Record<string, unknown>) => request<ValidationResult>('POST', '/automations/validate', config),
  createAutomation: (config: Record<string, unknown>, enabled?: boolean) =>
    request<AutomationInfo>('POST', `/automations${enabled === false ? '?enabled=false' : ''}`, config),
  updateAutomation: (id: string, config: Record<string, unknown>) => request<AutomationInfo>('PUT', `/automations/${enc(id)}`, config),
  deleteAutomation: (id: string) => request<void>('DELETE', `/automations/${enc(id)}`),
  setAutomationEnabled: (id: string, enabled: boolean) => request<AutomationInfo>('POST', `/automations/${enc(id)}/${enabled ? 'enable' : 'disable'}`),
  triggerAutomation: (id: string, skipConditions: boolean) =>
    request<{ runId: string | null; started: boolean }>('POST', `/automations/${enc(id)}/trigger`, { skip_conditions: skipConditions }),
  automationTraces: (id: string) => request<Trace[]>('GET', `/automations/${enc(id)}/traces`),
  automationVersions: (id: string) => request<AutomationVersion[]>('GET', `/automations/${enc(id)}/versions`),

  recentCommands: (limit = 50) => request<AuditRow[]>('GET', `/commands/recent?limit=${limit}`),

  confirmations: (status?: ConfirmationStatus) => request<ConfirmationDTO[]>('GET', `/confirmations${status ? `?status=${status}` : ''}`),
  confirmation: (id: string) => request<ConfirmationDTO>('GET', `/confirmations/${enc(id)}`),
  approveConfirmation: (id: string) => request<ConfirmationDTO>('POST', `/confirmations/${enc(id)}/approve`),
  denyConfirmation: (id: string) => request<ConfirmationDTO>('POST', `/confirmations/${enc(id)}/deny`),

  uiSettings: () => request<{ wall: WallSettings }>('GET', '/ui/settings'),
  updateWallSettings: (wall: Partial<Pick<WallSettings, 'cardOpacity' | 'backgroundBlur' | 'backgroundDim'>>) => request<{ wall: WallSettings }>('PATCH', '/ui/settings', { wall }),
  deleteWallBackground: () => request<{ wall: WallSettings }>('DELETE', '/ui/wall-background'),
  uploadWallBackground,
};

/** XHR rather than fetch: fetch cannot report upload progress. */
function uploadWallBackground(image: Blob, onProgress?: (fraction: number) => void): Promise<{ wall: WallSettings }> {
  const token = auth.get();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/v1/ui/wall-background');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', image.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, { code: 'NETWORK', message: 'Upload failed' }));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as { wall: WallSettings });
      if (xhr.status === 401 && token === auth.get()) signOut();
      const err = (data as ApiErrorBody | undefined)?.error ?? { code: 'HTTP_' + xhr.status, message: xhr.statusText || 'Upload failed' };
      reject(new ApiError(xhr.status, err));
    };
    xhr.send(image);
  });
}

/** Image URLs cannot carry an Authorization header, so the token rides along in the query. */
export function withToken(url: string): string {
  const token = auth.get();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.hint ? `${err.message} (${err.hint})` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
