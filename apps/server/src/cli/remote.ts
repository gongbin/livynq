import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandBody, ConfirmationDTO, DeviceDTO, Room, SystemInfo } from '@livynq/model';
import type { FloorPlan, HistoryPoint } from '@livynq/core';
import type { CommandOutcome, DeviceFilter, HistoryQuery, HomeApi } from '@livynq/agent';
import type { AutomationInfo, Trace } from '@livynq/automation';

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export interface RemoteOptions {
  url: string;
  token: string;
}

/** Resolves where the CLI talks to: flags > env > local data dir (token file written by `livynq start`). */
export function resolveRemote(flags: { url?: string; token?: string; dataDir: string; port: number }): RemoteOptions {
  const url = (flags.url ?? process.env.LIVYNQ_URL ?? `http://127.0.0.1:${flags.port}`).replace(/\/$/, '');
  let token = flags.token ?? process.env.LIVYNQ_TOKEN;
  const tokenFile = join(flags.dataDir, 'secrets', 'cli.token');
  if (!token && existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'No access token', `Pass --token, set LIVYNQ_TOKEN, or run on the machine where "livynq start" runs (${tokenFile})`);
  return { url, token };
}

export class RemoteClient implements HomeApi {
  readonly #options: RemoteOptions;

  constructor(options: RemoteOptions) {
    this.#options = options;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.#options.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#options.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'UNREACHABLE', `Cannot reach Livynq at ${this.#options.url}`, 'Is "livynq start" running? Use --url for a remote instance.');
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; hint?: string } };
    if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'HTTP_ERROR', data.error?.message ?? res.statusText, data.error?.hint);
    return data as T;
  }

  info() {
    return this.request<SystemInfo>('GET', '/api/v1/system/info');
  }

  rooms() {
    return this.request<Room[]>('GET', '/api/v1/rooms');
  }

  devices(filter: DeviceFilter = {}) {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
    return this.request<DeviceDTO[]>('GET', `/api/v1/devices${qs ? `?${qs}` : ''}`);
  }

  device(ref: string) {
    return this.request<DeviceDTO>('GET', `/api/v1/devices/${encodeURIComponent(ref)}`);
  }

  history(ref: string, q: HistoryQuery) {
    const qs = new URLSearchParams({ capability: q.capability, attribute: q.attribute, from: String(q.from), to: String(q.to), ...(q.endpoint === undefined ? {} : { endpoint: String(q.endpoint) }) });
    return this.request<HistoryPoint[]>('GET', `/api/v1/devices/${encodeURIComponent(ref)}/history?${qs}`);
  }

  /** The server applies this token's own source name and risk limit. */
  async command(deviceId: string, endpointId: number, body: CommandBody): Promise<CommandOutcome> {
    const r = await this.request<{ ok: boolean; pending?: boolean; confirmation?: ConfirmationDTO }>(
      'POST',
      `/api/v1/devices/${encodeURIComponent(deviceId)}/endpoints/${endpointId}/commands`,
      body,
    );
    return r.pending && r.confirmation ? { status: 'pending', confirmation: r.confirmation } : { status: 'executed' };
  }

  confirmation(id: string) {
    return this.request<ConfirmationDTO>('GET', `/api/v1/confirmations/${encodeURIComponent(id)}`);
  }

  floorplan() {
    return this.request<FloorPlan & { adjacency: Record<string, string[]> }>('GET', '/api/v1/floorplan');
  }

  automations() {
    return this.request<AutomationInfo[]>('GET', '/api/v1/automations');
  }

  automationTraces(id: string) {
    return this.request<Trace[]>('GET', `/api/v1/automations/${encodeURIComponent(id)}/traces`);
  }

  proposeAutomation(config: Record<string, unknown>) {
    return this.request<AutomationInfo>('POST', '/api/v1/automations/proposals', config);
  }
}
