import type {
  ApiErrorBody,
  CommandBody,
  ConfirmationDTO,
  DeviceDTO,
  ExposurePolicy,
  HomeKitBridgeInfo,
  MatterBridgeInfo,
  Level,
  Placement,
  PushInfo,
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
  kind?: 'api' | 'session';
  userId?: string | null;
  /** Who created the token (API tokens) */
  owner?: { id: string; username: string; displayName: string } | null;
}

export type Role = 'owner' | 'admin' | 'member' | 'guest';

/** Mirrors `User` in packages/core/src/users.ts */
export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  allowedRooms: string[] | null;
  riskLimit: Risk | null;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  sessions?: number;
}

export interface Me {
  token: TokenInfo;
  /** null for access tokens from before accounts (e.g. the CLI link) */
  user: User | null;
  access: { rooms: string[] | null; automations: boolean; canRequestApproval: boolean };
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

/** `GET /api/v1/floorplan` (apps/server/src/routes/spaces.ts). */
export interface FloorPlanDTO {
  levels: Level[];
  rooms: Room[];
  placements: { deviceId: string; placement: Placement }[];
  adjacency: Record<string, string[]>;
}

export interface RoomPatch {
  name?: string;
  sortOrder?: number;
  levelId?: string | null;
  polygon?: [number, number][] | null;
  color?: string | null;
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

export type PluginMethodId = 'matter' | 'zigbee' | 'zwave' | 'esphome' | 'shelly' | 'hue' | 'xiaomi' | 'camera' | 'homebridge' | 'homeassistant' | 'virtual';
export type OnboardingMethodId = PluginMethodId | 'mqtt';

export interface PluginActionInfo {
  name: string;
  description: string;
}

/** Mirrors `GET /api/v1/onboarding` (apps/server/src/routes/onboarding.ts). */
export type OnboardingMethod =
  | { id: PluginMethodId; module: string; plugin: string; enabled: boolean; actions: PluginActionInfo[] }
  | { id: 'mqtt'; enabled: boolean; broker: { url: string | null; builtin: boolean; port: number; discoveryPrefix: string } | null };

export interface Onboarding {
  methods: OnboardingMethod[];
  homekit: { enabled: boolean };
  matterBridge: { enabled: boolean };
}

export type PluginStatus = 'running' | 'starting' | 'crashed' | 'disabled' | 'stopped';

/** One row of `GET /api/v1/plugins` (in-process plugins report fewer fields). */
export interface PluginInfo {
  id: string;
  module: string;
  isolation: 'process' | 'in-process';
  status: PluginStatus;
  lastError?: string | null;
  actions: PluginActionInfo[];
}

/** Settings → Plugins: one row of `GET /api/v1/plugins?all=1` (apps/server/src/plugins/manager.ts). */
export interface PluginRow {
  id: string;
  module?: string;
  path?: string;
  description?: string;
  source: 'bundled' | 'builtin' | 'installed' | 'path' | 'missing';
  official: boolean;
  version: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  configured: boolean;
  enabled: boolean;
  status: PluginStatus | 'off' | 'missing';
  isolation: 'process' | 'in-process';
  config: Record<string, unknown>;
  lastError: string | null;
  pid?: number | null;
  restarts?: number;
  devices?: number;
  actions: PluginActionInfo[];
  installed?: { source: 'registry' | 'file'; spec: string; installedAt: number; packages: number };
  canUninstall: boolean;
  canUpgrade: boolean;
}

/** `POST /api/v1/plugins/resolve`: what an install would do, nothing written yet. */
export interface PluginPreview {
  id: string;
  root: { name: string; version: string; description?: string; author?: string; license?: string; homepage?: string; hasInstallScript: boolean };
  packages: { name: string; version: string; path: string; hasInstallScript: boolean }[];
  sdk: { ranges: string[]; provided: string; compatible: boolean };
  warnings: string[];
  source: 'registry' | 'file';
  spec: string;
  installedVersion: string | null;
  conflict?: string;
  uploadId?: string;
}

/** Where an import reads Home Assistant's config: a path on the hub, or an uploaded backup. */
export type ImportSource = { path: string } | { upload: string };

/** Mirrors ImportPlan (packages/importer-homeassistant) without the operations list. */
export interface ImportPlan {
  source: string;
  haVersion?: string;
  location?: { latitude: number; longitude: number; timeZone?: string };
  rooms: { areaId: string; name: string; action: 'create' | 'match'; roomId?: string }[];
  devices: {
    haDeviceId: string;
    name: string;
    manufacturer?: string;
    model?: string;
    area?: string;
    integration: string;
    status: 'matched' | 'pending' | 'unsupported';
    livynqDeviceId?: string;
    reason?: string;
    entities: { haEntityId: string; livynqEntityId?: string; status: 'same' | 'rename' | 'conflict' | 'missing' | 'skipped'; reason?: string }[];
  }[];
  automations: { id: string; alias: string; status: 'import' | 'invalid' | 'exists'; errors: string[]; missingEntities: string[] }[];
  notImported: { scripts: number; scenes: number; blueprints: number; floors: number };
  warnings: string[];
  summary: { rooms: number; devicesMatched: number; devicesPending: number; devicesUnsupported: number; entityRenames: number; automations: number; automationsInvalid: number };
}

export interface ImportRecord {
  id: string;
  source: string;
  createdAt: number;
  createdBy: string;
  revertedAt: number | null;
  summary: ImportPlan['summary'];
  applied: { operations: number; failed: { operation: Record<string, unknown>; error: string }[] };
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

/** Ends this session on the server too (a no-op for access tokens), then signs out here. */
export async function logout(): Promise<void> {
  const token = auth.get();
  if (token) await fetch('/api/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  signOut();
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
  me: (token?: string) => request<Me>('GET', '/auth/me', undefined, token ?? auth.get()),
  authStatus: () => request<{ users: boolean; setupHere: boolean }>('GET', '/auth/status', undefined, null),
  login: (username: string, password: string) => request<{ token: string; user: User }>('POST', '/auth/login', { username, password }, null),
  setupOwner: (body: { username: string; displayName?: string; password: string }) => request<{ token: string; user: User }>('POST', '/auth/setup', body),
  logoutAll: () => request<{ signedOut: number }>('POST', '/auth/logout-all'),
  changePassword: (current: string, password: string) => request<{ ok: true }>('POST', '/auth/password', { current, password }),
  users: () => request<User[]>('GET', '/users'),
  createUser: (body: { username: string; displayName?: string; password: string; role: Role; allowedRooms?: string[] | null }) => request<User>('POST', '/users', body),
  updateUser: (id: string, patch: Partial<Pick<User, 'displayName' | 'role' | 'allowedRooms' | 'disabled' | 'riskLimit'>>) => request<User>('PATCH', `/users/${enc(id)}`, patch),
  resetPassword: (id: string, password: string) => request<{ ok: true }>('POST', `/users/${enc(id)}/password`, { password }),
  deleteUser: (id: string) => request<void>('DELETE', `/users/${enc(id)}`),
  transferOwnership: (id: string) => request<User>('POST', `/users/${enc(id)}/transfer-ownership`),
  systemInfo: () => request<SystemInfo>('GET', '/system/info'),
  pushInfo: () => request<PushInfo>('GET', '/push'),
  pushSubscribe: (subscription: unknown, name: string) => request<{ endpoint: string }>('POST', '/push/subscriptions', { subscription, name }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>('DELETE', '/push/subscriptions', { endpoint }),
  pushTest: (endpoint?: string) => request<{ sent: number; failed: number }>('POST', '/push/test', endpoint ? { endpoint } : {}),

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
  updateRoom: (id: string, patch: RoomPatch) => request<Room>('PATCH', `/rooms/${enc(id)}`, patch),
  deleteRoom: (id: string) => request<void>('DELETE', `/rooms/${enc(id)}`),

  floorPlan: () => request<FloorPlanDTO>('GET', '/floorplan'),
  createLevel: (name: string, elevation?: number) => request<Level>('POST', '/levels', elevation === undefined ? { name } : { name, elevation }),
  updateLevel: (id: string, patch: { name?: string; elevation?: number; sortOrder?: number }) => request<Level>('PATCH', `/levels/${enc(id)}`, patch),
  deleteLevel: (id: string) => request<void>('DELETE', `/levels/${enc(id)}`),
  deleteLevelBackground: (id: string) => request<Level>('DELETE', `/levels/${enc(id)}/background`),
  scaleLevelBackground: (id: string, widthMeters: number) => request<Level>('PATCH', `/levels/${enc(id)}/background`, { widthMeters }),
  uploadLevelBackground: (id: string, image: Blob, widthMeters: number, onProgress?: (fraction: number) => void) =>
    upload<Level>(`/api/v1/levels/${enc(id)}/background?widthMeters=${widthMeters}`, image, onProgress),
  placeDevice: (id: string, placement: Placement | null) => request<{ roomId: string | null }>('PUT', `/devices/${enc(id)}/placement`, placement),

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
  uploadWallBackground: (image: Blob, onProgress?: (fraction: number) => void) => upload<{ wall: WallSettings }>('/api/v1/ui/wall-background', image, onProgress),

  matterBridge: () => request<MatterBridgeInfo>('GET', '/matter'),

  /** Home Assistant migration (apps/server/src/routes/imports.ts). */
  uploadImport: (file: Blob, name: string, onProgress?: (fraction: number) => void) =>
    upload<{ upload: string; size: number }>(`/api/v1/imports/uploads?name=${enc(name)}`, file, onProgress, { method: 'POST', type: 'application/octet-stream' }),
  planImport: (source: ImportSource) => request<ImportPlan>('POST', '/imports/homeassistant/plan', source),
  applyImport: (source: ImportSource, enableAutomations: boolean) =>
    request<{ import: ImportRecord; report: ImportPlan }>('POST', '/imports/homeassistant/apply', { ...source, enableAutomations }),
  imports: () => request<ImportRecord[]>('GET', '/imports'),
  revertImport: (id: string) => request<{ reverted: number; skipped: string[] }>('POST', `/imports/${enc(id)}/revert`),
  reconfigurePlugin: (id: string, config: Record<string, unknown>) => request<{ id: string; status: string; lastError: string | null }>('PATCH', `/plugins/${enc(id)}`, { config }),

  onboarding: () => request<Onboarding>('GET', '/onboarding'),
  plugins: () => request<PluginInfo[]>('GET', '/plugins'),
  enablePlugin: (module: string, config?: Record<string, unknown>) =>
    request<{ id: string; enabled: boolean; actions: PluginActionInfo[] }>('POST', '/plugins', config ? { module, config } : { module }),
  pluginAction: <T = unknown>(plugin: string, action: string, params: Record<string, unknown> = {}) =>
    request<{ result: T }>('POST', `/plugins/${enc(plugin)}/actions/${enc(action)}`, params).then((r) => r.result),
  restartPlugin: (id: string) => request<PluginInfo>('POST', `/plugins/${enc(id)}/restart`),
  pluginRows: (updates = false, force = false) => request<PluginRow[]>('GET', `/plugins?all=1${updates ? '&updates=1' : ''}${force ? '&force=1' : ''}`),
  resolvePluginSpec: (spec: string) => request<PluginPreview>('POST', '/plugins/resolve', { spec }),
  resolvePluginFile: (file: Blob, name: string, onProgress?: (fraction: number) => void) =>
    upload<PluginPreview>(`/api/v1/plugins/resolve?filename=${enc(name)}`, file, onProgress, { method: 'POST', type: 'application/gzip' }),
  installPlugin: (source: { spec: string } | { uploadId: string }) => request<PluginRow & { warnings: string[] }>('POST', '/plugins/install', source),
  upgradePlugin: (id: string) => request<PluginRow & { upgraded: boolean; from: string | null }>('POST', `/plugins/${enc(id)}/upgrade`),
  setPluginEnabled: (id: string, enabled: boolean) => request<PluginRow>('POST', `/plugins/${enc(id)}/${enabled ? 'enable' : 'disable'}`),
  configurePlugin: (id: string, config: Record<string, unknown>) => request<PluginRow>('PUT', `/plugins/${enc(id)}/config`, { config }),
  removePlugin: (id: string, uninstall: boolean) => request<void>('DELETE', `/plugins/${enc(id)}${uninstall ? '?uninstall=true' : ''}`),
  serialPorts: () => request<{ path: string; label: string }[]>('GET', '/system/serial-ports'),
};

/** Raw body upload (images: PUT with their type). XHR rather than fetch: fetch cannot report upload progress. */
function upload<T>(url: string, image: Blob, onProgress?: (fraction: number) => void, opts: { method?: string; type?: string } = {}): Promise<T> {
  const token = auth.get();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method ?? 'PUT', url);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', opts.type ?? image.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, { code: 'NETWORK', message: 'Upload failed' }));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
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
