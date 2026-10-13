import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { callService, EntityStateTracker, listServices, LivynqError, type Exporter, type Home, type Logger } from '@livynq/core';
import { normalizeAutomation, type Action, type Automation, type Condition } from './schema.ts';
import { attachTrigger, evaluate, type RuntimeEnv, type TriggerVars, type WebhookRequest } from './runtime.ts';
import type { Location } from './sun.ts';

export interface AutomationEngineOptions {
  location?: Location;
  /** Traces kept per automation. */
  traceLimit?: number;
}

export type RunState = 'running' | 'finished' | 'stopped' | 'error' | 'aborted';

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

export interface AutomationInfo {
  id: string;
  alias: string;
  description?: string;
  mode: string;
  enabled: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  config: Record<string, unknown>;
  version: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastTriggered: number | null;
  running: number;
}

interface Entry {
  info: Omit<AutomationInfo, 'running'>;
  automation?: Automation;
  disarm?: () => void;
  runs: Set<Run>;
  queue: TriggerVars[];
}

class StopRun extends Error {
  readonly error: boolean;
  constructor(reason: string, error = false) {
    super(reason);
    this.error = error;
  }
}

class Run {
  readonly trace: Trace;
  readonly controller = new AbortController();

  constructor(automationId: string, trigger: TriggerVars) {
    const { description, ...vars } = trigger;
    this.trace = {
      runId: randomUUID(),
      automationId,
      startedAt: Date.now(),
      state: 'running',
      trigger: { description, vars: compact(vars) },
      conditions: [],
      steps: [],
    };
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

/** Keeps traces small: entity states are reduced to state + a few attributes. */
function compact(vars: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(vars, (_k, v) => (v && typeof v === 'object' && 'entity_id' in v && 'attributes' in v ? { entity_id: v.entity_id, state: v.state } : v)));
}

/**
 * Runs Home Assistant–style automations against Livynq entities.
 * Triggers fire on entity state changes (via EntityStateTracker), clocks, the sun, webhooks and lifecycle;
 * every run produces a trace that can be inspected in the UI, the CLI or by an agent.
 */
export class AutomationEngine implements Exporter {
  readonly id = 'automations';
  readonly #options: AutomationEngineOptions;
  #home!: Home;
  #log!: Logger;
  #env!: RuntimeEnv;
  #tracker!: EntityStateTracker;
  readonly #entries = new Map<string, Entry>();

  constructor(options: AutomationEngineOptions = {}) {
    this.#options = options;
  }

  async start(home: Home): Promise<void> {
    this.#home = home;
    this.#log = home.log.child({ extension: 'automations' });
    this.#tracker = new EntityStateTracker(home);
    this.#tracker.start();
    this.#env = { tracker: this.#tracker, log: this.#log, location: this.#options.location, webhooks: new Map(), lifecycle: new Set() };
    const rows = home.storage.sql('SELECT * FROM automations ORDER BY created_at').all() as Record<string, string | number | null>[];
    for (const row of rows) {
      const config = JSON.parse(String(row.config)) as Record<string, unknown>;
      const entry = this.#entry(config, {
        id: String(row.id),
        enabled: row.enabled === 1,
        version: Number(row.version),
        createdBy: String(row.created_by),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastTriggered: row.last_triggered === null ? null : Number(row.last_triggered),
      });
      this.#entries.set(entry.info.id, entry);
      this.#arm(entry);
    }
    this.#log.info({ count: this.#entries.size }, 'automations loaded');
    for (const listener of this.#env.lifecycle) listener('start');
  }

  async stop(): Promise<void> {
    for (const listener of this.#env.lifecycle) listener('shutdown');
    // Give shutdown automations a moment, then abort everything.
    const deadline = Date.now() + 2000;
    while ([...this.#entries.values()].some((e) => e.runs.size) && Date.now() < deadline) await sleep(50);
    for (const entry of this.#entries.values()) {
      entry.disarm?.();
      for (const run of entry.runs) run.controller.abort();
    }
    this.#tracker.stop();
  }

  // ---------------------------------------------------------------- management

  list(): AutomationInfo[] {
    return [...this.#entries.values()].map((e) => ({ ...e.info, running: e.runs.size }));
  }

  get(id: string): AutomationInfo {
    const entry = this.#require(id);
    return { ...entry.info, running: entry.runs.size };
  }

  /**
   * Errors block saving; warnings (e.g. entity ids that do not exist yet) do not,
   * because devices may appear later (MQTT discovery, imports).
   */
  validate(config: unknown): { ok: boolean; errors: string[]; warnings: string[]; automation?: Automation } {
    const { automation, errors } = normalizeAutomation(config);
    // Check action names on the raw config too, so they are reported together with schema errors.
    const unsupported = this.#unsupportedRawActions(config).filter((e) => !errors.includes(e));
    const warnings = this.#home
      ? [...new Set(entityRefs(config))].filter((id) => !this.#home.registry.getEntity(id) && !id.startsWith('automation.') && !this.#entries.has(id.slice(11))).map((id) => `unknown entity ${id}`)
      : [];
    return { ok: errors.length + unsupported.length === 0, errors: [...errors, ...unsupported], warnings, automation };
  }

  /**
   * Creates or replaces an automation. Invalid configs are rejected (nothing is stored).
   * `onlyCreate` refuses to overwrite an existing id.
   */
  save(
    config: Record<string, unknown>,
    source: string,
    options: { enabled?: boolean; onlyCreate?: boolean; id?: string; /** Store invalid configs (disabled) instead of rejecting: used by importers. */ allowInvalid?: boolean } = {},
  ): AutomationInfo {
    const raw = { ...config, ...(options.id ? { id: options.id } : {}) };
    const { ok, errors, automation } = this.validate(raw);
    const id = automation?.id ?? (typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : undefined);
    if ((!ok || !automation) && !(options.allowInvalid && id && /^[A-Za-z0-9_-]{1,64}$/.test(id))) {
      throw new LivynqError('INVALID_PARAMS', `Invalid automation: ${errors.join('; ')}`, errors.join('\n'));
    }
    const previous = this.#entries.get(id!);
    if (previous && options.onlyCreate) throw new LivynqError('CONFLICT', `Automation ${id} already exists`);
    const now = Date.now();
    const stored = { ...raw, id: id! };
    const info = {
      id: id!,
      enabled: ok ? (options.enabled ?? previous?.info.enabled ?? true) : false,
      version: (previous?.info.version ?? 0) + 1,
      createdBy: previous?.info.createdBy ?? source,
      createdAt: previous?.info.createdAt ?? now,
      updatedAt: now,
      lastTriggered: previous?.info.lastTriggered ?? null,
    };
    this.#home.storage.transaction(() => {
      this.#home.storage
        .sql(
          `INSERT INTO automations (id, config, enabled, version, created_by, created_at, updated_at, last_triggered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET config = excluded.config, enabled = excluded.enabled, version = excluded.version, updated_at = excluded.updated_at`,
        )
        .run(info.id, JSON.stringify(stored), info.enabled ? 1 : 0, info.version, info.createdBy, info.createdAt, info.updatedAt, info.lastTriggered);
      this.#home.storage
        .sql('INSERT INTO automation_versions (automation_id, version, config, source, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(info.id, info.version, JSON.stringify(stored), source, now);
    });
    if (previous) {
      previous.disarm?.();
      for (const run of previous.runs) run.controller.abort();
    }
    const entry = this.#entry(stored, info);
    this.#entries.set(info.id, entry);
    this.#arm(entry);
    this.#log.info({ id: info.id, version: info.version, source }, previous ? 'automation updated' : 'automation created');
    return this.get(info.id);
  }

  remove(id: string): void {
    const entry = this.#require(id);
    entry.disarm?.();
    for (const run of entry.runs) run.controller.abort();
    this.#home.storage.transaction(() => {
      for (const table of ['automations', 'automation_versions', 'automation_traces']) {
        this.#home.storage.sql(`DELETE FROM ${table} WHERE ${table === 'automations' ? 'id' : 'automation_id'} = ?`).run(id);
      }
    });
    this.#entries.delete(id);
  }

  setEnabled(id: string, enabled: boolean): AutomationInfo {
    const entry = this.#require(id);
    entry.info.enabled = enabled;
    this.#home.storage.sql('UPDATE automations SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    entry.disarm?.();
    entry.disarm = undefined;
    if (!enabled) for (const run of entry.runs) run.controller.abort();
    this.#arm(entry);
    return this.get(id);
  }

  versions(id: string): { version: number; source: string; createdAt: number; config: unknown }[] {
    this.#require(id);
    return (this.#home.storage.sql('SELECT * FROM automation_versions WHERE automation_id = ? ORDER BY version DESC').all(id) as Record<string, string | number>[]).map((r) => ({
      version: Number(r.version),
      source: String(r.source),
      createdAt: Number(r.created_at),
      config: JSON.parse(String(r.config)),
    }));
  }

  /**
   * Runs an automation now. By default conditions are skipped, like HA's "Run" button.
   * Returns the run id, or undefined when the mode refused or queued the run.
   */
  trigger(id: string, options: { skipConditions?: boolean; source?: string } = {}): string | undefined {
    const entry = this.#require(id);
    if (!entry.automation) throw new LivynqError('INVALID_PARAMS', `Automation ${id} is invalid: ${entry.info.errors.join('; ')}`);
    return this.#onTrigger(entry, { id: 'manual', idx: 'manual', platform: 'manual', source: options.source ?? 'manual', description: `manual run (${options.source ?? 'manual'})` }, options.skipConditions ?? true);
  }

  traces(id: string): Trace[] {
    this.#require(id);
    const stored = (this.#home.storage.sql('SELECT trace FROM automation_traces WHERE automation_id = ? ORDER BY started_at DESC').all(id) as { trace: string }[]).map(
      (r) => JSON.parse(r.trace) as Trace,
    );
    const running = [...this.#require(id).runs].map((r) => r.trace);
    return [...running, ...stored.filter((t) => !running.some((r) => r.runId === t.runId))];
  }

  trace(id: string, runId: string): Trace {
    const found = this.traces(id).find((t) => t.runId === runId);
    if (!found) throw new LivynqError('NOT_FOUND', `Trace ${runId} not found`);
    return found;
  }

  /** Returns true when at least one webhook trigger listens on this id (callers answer 200 either way). */
  handleWebhook(webhookId: string, request: WebhookRequest): boolean {
    const listeners = this.#env.webhooks.get(webhookId);
    listeners?.forEach((l) => l(request));
    return Boolean(listeners?.size);
  }

  /** Resolves when the given run finishes (tests, CLI). */
  async waitForRun(id: string, runId: string, timeoutMs = 10_000): Promise<Trace> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const trace = this.traces(id).find((t) => t.runId === runId);
      if (trace && trace.state !== 'running') return trace;
      if (Date.now() > deadline) throw new LivynqError('TIMEOUT', `Run ${runId} still running`);
      await sleep(10);
    }
  }

  // ---------------------------------------------------------------- internals

  #require(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new LivynqError('NOT_FOUND', `Automation not found: ${id}`);
    return entry;
  }

  #entry(config: Record<string, unknown>, meta: Omit<AutomationInfo, 'running' | 'alias' | 'mode' | 'valid' | 'errors' | 'warnings' | 'config' | 'description'>): Entry {
    const { ok, errors, warnings, automation } = this.validate(config);
    return {
      info: {
        ...meta,
        alias: automation?.alias ?? String(config.alias ?? meta.id),
        ...(automation?.description ? { description: automation.description } : {}),
        mode: automation?.mode ?? String(config.mode ?? 'single'),
        valid: ok,
        errors,
        warnings,
        config,
      },
      automation: ok ? automation : undefined,
      runs: new Set(),
      queue: [],
    };
  }

  #arm(entry: Entry): void {
    if (!entry.info.enabled || !entry.automation || entry.disarm) return;
    const offs = entry.automation.triggers.flatMap((t, i) => (t.enabled === false ? [] : [attachTrigger(this.#env, t, i, (vars) => this.#onTrigger(entry, vars, false))]));
    entry.disarm = () => offs.forEach((off) => off());
  }

  #onTrigger(entry: Entry, vars: TriggerVars, skipConditions: boolean): string | undefined {
    const automation = entry.automation!;
    const busy = entry.runs.size > 0;
    switch (automation.mode) {
      case 'single':
        if (busy) {
          this.#log.warn({ id: automation.id }, 'already running (mode: single); trigger ignored');
          return undefined;
        }
        break;
      case 'restart':
        for (const run of entry.runs) run.controller.abort('restart');
        break;
      case 'queued':
        if (busy) {
          if (entry.queue.length + entry.runs.size >= automation.max) this.#log.warn({ id: automation.id }, 'queue full; trigger dropped');
          else entry.queue.push(vars);
          return undefined;
        }
        break;
      case 'parallel':
        if (entry.runs.size >= automation.max) {
          this.#log.warn({ id: automation.id }, 'max parallel runs reached; trigger dropped');
          return undefined;
        }
    }
    const run = new Run(automation.id, vars);
    entry.runs.add(run);
    entry.info.lastTriggered = run.trace.startedAt;
    this.#home.storage.sql('UPDATE automations SET last_triggered = ? WHERE id = ?').run(run.trace.startedAt, automation.id);
    void this.#execute(entry, run, skipConditions).finally(() => {
      entry.runs.delete(run);
      const next = entry.queue.shift();
      if (next && entry.info.enabled) this.#onTrigger(entry, next, false);
    });
    return run.trace.runId;
  }

  async #execute(entry: Entry, run: Run, skipConditions: boolean): Promise<void> {
    const automation = entry.automation!;
    const trace = run.trace;
    try {
      if (!skipConditions && !this.#check(automation.conditions, 'conditions', run)) throw new StopRun('conditions not met');
      await this.#runSequence(automation.actions, 'actions', run);
      trace.state = 'finished';
    } catch (err) {
      if (run.signal.aborted) {
        trace.state = 'aborted';
        trace.stopReason = String(run.signal.reason ?? 'aborted');
      } else if (err instanceof StopRun) {
        trace.state = err.error ? 'error' : 'stopped';
        trace.stopReason = err.message;
      } else {
        trace.state = 'error';
        trace.error = err instanceof Error ? err.message : String(err);
        this.#log.warn({ id: automation.id, err: trace.error }, 'automation failed');
      }
    } finally {
      trace.finishedAt = Date.now();
      this.#persistTrace(trace);
    }
  }

  #persistTrace(trace: Trace): void {
    const limit = this.#options.traceLimit ?? 20;
    this.#home.storage.transaction(() => {
      this.#home.storage.sql('INSERT INTO automation_traces (run_id, automation_id, started_at, trace) VALUES (?, ?, ?, ?)').run(trace.runId, trace.automationId, trace.startedAt, JSON.stringify(trace));
      this.#home.storage
        .sql(
          `DELETE FROM automation_traces WHERE automation_id = ? AND run_id NOT IN
           (SELECT run_id FROM automation_traces WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?)`,
        )
        .run(trace.automationId, trace.automationId, limit);
    });
  }

  #check(conditions: Condition[], path: string, run: Run): boolean {
    const record = (p: string, result: boolean) => run.trace.conditions.push({ path: p, result });
    const ctx = { env: this.#env, trigger: { ...run.trace.trigger.vars, description: run.trace.trigger.description } as TriggerVars };
    return conditions.every((c, i) => evaluate(c, ctx, `${path}/${i}`, record));
  }

  async #runSequence(actions: Action[], path: string, run: Run): Promise<void> {
    for (let i = 0; i < actions.length; i++) {
      if (run.signal.aborted) throw new StopRun('aborted');
      if (actions[i]!.enabled === false) continue;
      await this.#runAction(actions[i]!, `${path}/${i}`, run);
    }
  }

  async #runAction(action: Action, path: string, run: Run): Promise<void> {
    const step: TraceStep = { path, type: action.type, ...(action.alias ? { alias: action.alias } : {}), startedAt: Date.now() };
    run.trace.steps.push(step);
    try {
      step.result = await this.#perform(action, path, run);
    } catch (err) {
      if (err instanceof StopRun || run.signal.aborted) throw err;
      step.error = err instanceof Error ? err.message : String(err);
      if (!action.continue_on_error) throw err;
    } finally {
      step.finishedAt = Date.now();
    }
  }

  async #perform(action: Action, path: string, run: Run): Promise<unknown> {
    const source = `automation:${run.trace.automationId}`;
    switch (action.type) {
      case 'service': {
        const [domain] = action.action.split('.');
        if (domain === 'automation') return this.#automationService(action.action, action.target, source);
        return callService(this.#home, { action: action.action, target: action.target, data: action.data }, source);
      }
      case 'delay':
        await sleep(action.delay, undefined, { signal: run.signal }).catch(() => {
          throw new StopRun('aborted');
        });
        return { delay: action.delay };
      case 'wait_for_trigger': {
        const result = await this.#waitForTrigger(action, run);
        if (!result && !action.continue_on_timeout) throw new StopRun('wait_for_trigger timed out');
        return result ? { trigger: result.description } : { timeout: true };
      }
      case 'condition':
        if (!this.#check([action.condition], `${path}/condition`, run)) throw new StopRun('condition failed');
        return { result: true };
      case 'choose': {
        for (let i = 0; i < action.choose.length; i++) {
          const option = action.choose[i]!;
          if (this.#check(option.conditions, `${path}/choose/${i}/conditions`, run)) {
            await this.#runSequence(option.sequence, `${path}/choose/${i}/sequence`, run);
            return { choice: i };
          }
        }
        if (action.default) await this.#runSequence(action.default, `${path}/default`, run);
        return { choice: 'default' };
      }
      case 'if': {
        const result = this.#check(action.if, `${path}/if`, run);
        if (result) await this.#runSequence(action.then, `${path}/then`, run);
        else if (action.else) await this.#runSequence(action.else, `${path}/else`, run);
        return { result };
      }
      case 'repeat': {
        let iterations = 0;
        const max = 10_000;
        for (; iterations < max; iterations++) {
          if (action.count !== undefined && iterations >= action.count) break;
          if (action.while && !this.#check(action.while, `${path}/repeat/while`, run)) break;
          await this.#runSequence(action.sequence, `${path}/repeat/sequence`, run);
          if (action.until && this.#check(action.until, `${path}/repeat/until`, run)) {
            iterations++;
            break;
          }
          await sleep(0); // never starve the event loop on tight loops
        }
        return { iterations };
      }
      case 'parallel':
        await Promise.all(action.parallel.map((branch, i) => this.#runSequence(branch, `${path}/parallel/${i}`, run)));
        return { branches: action.parallel.length };
      case 'sequence':
        await this.#runSequence(action.sequence, `${path}/sequence`, run);
        return undefined;
      case 'stop':
        throw new StopRun(action.stop, action.error);
    }
  }

  #waitForTrigger(action: Extract<Action, { type: 'wait_for_trigger' }>, run: Run): Promise<TriggerVars | undefined> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const offs: (() => void)[] = [];
      const done = (value: TriggerVars | undefined, error?: unknown) => {
        clearTimeout(timer);
        offs.forEach((off) => off());
        run.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => done(undefined, new StopRun('aborted'));
      run.signal.addEventListener('abort', onAbort, { once: true });
      action.triggers.forEach((t, i) => t.enabled !== false && offs.push(attachTrigger(this.#env, t, i, (vars) => done(vars))));
      if (action.timeout !== undefined) timer = setTimeout(() => done(undefined), action.timeout);
    });
  }

  #automationService(name: string, target: Record<string, string | string[]> | undefined, source: string): unknown {
    const ids = [target?.entity_id ?? []].flat().map((e) => String(e).replace(/^automation\./, ''));
    if (!ids.length) throw new LivynqError('INVALID_PARAMS', `${name} needs target.entity_id: automation.<id>`);
    for (const id of ids) {
      if (name === 'automation.turn_on') this.setEnabled(id, true);
      else if (name === 'automation.turn_off') this.setEnabled(id, false);
      else if (name === 'automation.trigger') this.trigger(id, { source });
      else throw new LivynqError('NOT_SUPPORTED', `Unsupported action ${name}`);
    }
    return { automations: ids };
  }

  #unsupportedRawActions(config: unknown): string[] {
    const supported = new Set([
      ...Object.entries(listServices()).flatMap(([domain, services]) => services.map((s) => `${domain}.${s}`)),
      'automation.turn_on',
      'automation.turn_off',
      'automation.trigger',
    ]);
    const out: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (!value || typeof value !== 'object') return;
      const o = value as Record<string, unknown>;
      const name = o.action ?? o.service;
      if (typeof name === 'string' && /^[a-z_]+\.[a-z_]+$/.test(name) && !supported.has(name) && o.enabled !== false) {
        out.push(`${path}.action: "${name}" is not supported yet`);
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'data' && k !== 'target') walk(v, path ? `${path}.${k}` : k);
    };
    const root = (config ?? {}) as Record<string, unknown>;
    walk(root.actions ?? root.action, 'actions');
    return out;
  }
}

/** Entity ids referenced under `entity_id` keys anywhere in a config. */
function entityRefs(value: unknown, key?: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => entityRefs(v, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => entityRefs(v, k));
  if (key === 'entity_id' && typeof value === 'string') return value.split(',').map((s) => s.trim()).filter((s) => /^[a-z_]+\.[a-z0-9_]+$/.test(s));
  return [];
}
