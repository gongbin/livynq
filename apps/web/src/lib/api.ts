import type {
  ApiErrorBody,
  CommandBody,
  DeviceDTO,
  ExposurePolicy,
  HomeKitBridgeInfo,
  Room,
  SystemInfo,
  TokenScope,
} from '@livynq/model';
import { createStore, readLocal, writeLocal } from './store.ts';

const TOKEN_KEY = 'livynq.token';

export interface TokenInfo {
  id: string;
  name: string;
  scope: TokenScope;
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

/** The server prints `http://host:8581/#token=lvq_...`; consume it once and clean the URL. */
function readTokenFromUrl(): string | null {
  const match = /^#token=([^&]+)/.exec(location.hash);
  if (!match?.[1]) return null;
  const token = decodeURIComponent(match[1]);
  writeLocal(TOKEN_KEY, token);
  history.replaceState(null, '', `${location.pathname}${location.search}#/home`);
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
    request<{ ok: true }>('POST', `/devices/${enc(deviceId)}/endpoints/${endpointId}/commands`, body),
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
  createToken: (name: string, scope: TokenScope) => request<{ token: string; info: TokenInfo }>('POST', '/tokens', { name, scope }),
  revokeToken: (id: string) => request<void>('DELETE', `/tokens/${enc(id)}`),

  recentCommands: (limit = 50) => request<AuditRow[]>('GET', `/commands/recent?limit=${limit}`),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.hint ? `${err.message} (${err.hint})` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
