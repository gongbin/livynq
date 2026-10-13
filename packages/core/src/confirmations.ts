import { randomUUID } from 'node:crypto';
import { commandRisk, getCapability, getDeviceType, riskAtMost, type Risk } from '@livynq/model';
import { LivynqError } from './errors.ts';
import type { CommandRequest, Home } from './home.ts';

export type ConfirmationStatus = 'pending' | 'executed' | 'denied' | 'expired' | 'failed';

export interface Confirmation {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: ConfirmationStatus;
  requestedBy: string;
  request: CommandRequest;
  risk: Risk;
  /** Human readable, e.g. "Unlock Front Door Lock". */
  summary: string;
  decidedBy: string | null;
  decidedAt: number | null;
  error: string | null;
}

export interface Caller {
  /** Audit source, e.g. "agent:claude" or "api:script". */
  source: string;
  riskLimit: Risk;
}

export type GuardedResult = { status: 'executed'; risk: Risk } | { status: 'pending'; confirmation: Confirmation };

const TTL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;

const VERBS: Record<string, string> = {
  'doorLock.unlock': 'Unlock',
  'doorLock.lock': 'Lock',
  'windowCovering.open': 'Open',
  'windowCovering.close': 'Close',
  'windowCovering.goToPosition': 'Move',
  'onOff.on': 'Turn on',
  'onOff.off': 'Turn off',
};

/**
 * Human-in-the-loop for agents and scripts: commands above the caller's risk limit are queued
 * until a person approves them in the UI. Decisions and outcomes are kept for the audit trail.
 */
export class Confirmations {
  readonly #home: Home;
  readonly #rate = new Map<string, number[]>();

  constructor(home: Home) {
    this.#home = home;
  }

  riskOf(request: CommandRequest): Risk {
    const device = this.#home.registry.requireDevice(request.deviceId);
    const endpoint = device.endpoints.find((e) => e.id === request.endpointId);
    const capability = getCapability(request.capability);
    if (!endpoint || !capability) return 'low'; // invalid commands fail later with a precise error
    return commandRisk(capability.risk, endpoint.deviceType);
  }

  /** Executes when within the caller's limit, otherwise queues it for approval. */
  async guard(request: CommandRequest, caller: Caller): Promise<GuardedResult> {
    this.#checkRate(caller.source);
    const risk = this.riskOf(request);
    if (riskAtMost(risk, caller.riskLimit)) {
      await this.#home.command(request, caller.source);
      return { status: 'executed', risk };
    }
    return { status: 'pending', confirmation: this.#create(request, caller.source, risk) };
  }

  #checkRate(source: string): void {
    if (!/^(agent|api|proposal):/.test(source)) return;
    const now = Date.now();
    const recent = (this.#rate.get(source) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) throw new LivynqError('FORBIDDEN', `Rate limit: at most ${RATE_LIMIT} commands per minute for ${source}`);
    recent.push(now);
    this.#rate.set(source, recent);
  }

  #create(request: CommandRequest, requestedBy: string, risk: Risk): Confirmation {
    const device = this.#home.registry.requireDevice(request.deviceId);
    const endpoint = device.endpoints.find((e) => e.id === request.endpointId);
    const what = endpoint?.name && device.endpoints.length > 1 ? `${device.name} ${endpoint.name}` : device.name;
    const verb = VERBS[`${request.capability}.${request.command}`] ?? `${request.capability}.${request.command}`;
    const typeLabel = endpoint ? getDeviceType(endpoint.deviceType)?.label : undefined;
    const now = Date.now();
    const c: Confirmation = {
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + TTL_MS,
      status: 'pending',
      requestedBy,
      request: { ...request, params: request.params ?? {} },
      risk,
      summary: `${verb} ${what}${typeLabel ? ` (${typeLabel})` : ''}`,
      decidedBy: null,
      decidedAt: null,
      error: null,
    };
    this.#home.storage
      .sql(
        `INSERT INTO confirmations (id, created_at, expires_at, status, requested_by, device_id, endpoint_id, capability, command, params, risk, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.createdAt, c.expiresAt, c.status, c.requestedBy, request.deviceId, request.endpointId, request.capability, request.command, JSON.stringify(c.request.params), risk, c.summary);
    this.#home.log.info({ id: c.id, summary: c.summary, requestedBy }, 'confirmation requested');
    this.#home.bus.emit('confirmation', c);
    return c;
  }

  list(status?: ConfirmationStatus, limit = 50): Confirmation[] {
    this.#expire();
    const rows = (
      status
        ? this.#home.storage.sql('SELECT * FROM confirmations WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
        : this.#home.storage.sql('SELECT * FROM confirmations ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as Record<string, string | number | null>[];
    return rows.map(toConfirmation);
  }

  get(id: string): Confirmation {
    this.#expire();
    const row = this.#home.storage.sql('SELECT * FROM confirmations WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!row) throw new LivynqError('NOT_FOUND', `Confirmation not found: ${id}`);
    return toConfirmation(row);
  }

  async approve(id: string, decidedBy: string): Promise<Confirmation> {
    const c = this.#decide(id, decidedBy);
    try {
      await this.#home.command(c.request, `${c.requestedBy} (approved by ${decidedBy})`);
      return this.#finish(c, 'executed', null);
    } catch (err) {
      return this.#finish(c, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  deny(id: string, decidedBy: string): Confirmation {
    return this.#finish(this.#decide(id, decidedBy), 'denied', null);
  }

  #decide(id: string, decidedBy: string): Confirmation {
    const c = this.get(id);
    if (c.status !== 'pending') throw new LivynqError('CONFLICT', `Confirmation is ${c.status}`);
    return { ...c, decidedBy, decidedAt: Date.now() };
  }

  #finish(c: Confirmation, status: ConfirmationStatus, error: string | null): Confirmation {
    const done = { ...c, status, error };
    this.#home.storage
      .sql('UPDATE confirmations SET status = ?, decided_by = ?, decided_at = ?, error = ? WHERE id = ?')
      .run(status, done.decidedBy, done.decidedAt, error, c.id);
    this.#home.bus.emit('confirmation', done);
    return done;
  }

  #expire(): void {
    const now = Date.now();
    const expired = this.#home.storage.sql("SELECT * FROM confirmations WHERE status = 'pending' AND expires_at < ?").all(now) as Record<string, string | number | null>[];
    if (!expired.length) return;
    this.#home.storage.sql("UPDATE confirmations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(now);
    for (const row of expired) this.#home.bus.emit('confirmation', { ...toConfirmation(row), status: 'expired' });
  }
}

function toConfirmation(r: Record<string, string | number | null>): Confirmation {
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    status: r.status as ConfirmationStatus,
    requestedBy: String(r.requested_by),
    request: { deviceId: String(r.device_id), endpointId: Number(r.endpoint_id), capability: String(r.capability), command: String(r.command), params: JSON.parse(String(r.params)) },
    risk: r.risk as Risk,
    summary: String(r.summary),
    decidedBy: r.decided_by === null ? null : String(r.decided_by),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at),
    error: r.error === null ? null : String(r.error),
  };
}
