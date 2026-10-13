import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { LivynqError, type Adapter, type AdapterContext, type DeviceHandle } from '@livynq/core';
import type { ChildMessage, ParentMessage, StateSnapshot } from './protocol.ts';

export type PluginStatus = 'starting' | 'running' | 'crashed' | 'disabled' | 'stopped';

export interface PluginRuntimeInfo {
  id: string;
  module: string;
  isolation: 'process' | 'in-process';
  status: PluginStatus;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  devices: number;
}

export interface ProcessPluginOptions {
  id: string;
  /** Absolute path or file URL of the plugin's entry module. */
  module: string;
  config?: Record<string, unknown>;
  /** Crashes within `crashWindowMs` before the plugin is disabled. */
  maxCrashes?: number;
  crashWindowMs?: number;
  backoffMs?: number[];
}

/** In a single executable the binary relaunches itself as the plugin host; otherwise fork the TS entry. */
function spawnHost(id: string): ChildProcess {
  const env = { ...process.env, LIVYNQ_PLUGIN_ID: id };
  const stdio: ['ignore', 'pipe', 'pipe', 'ipc'] = ['ignore', 'pipe', 'pipe', 'ipc'];
  if (isSea()) return spawn(process.execPath, [], { stdio, env: { ...env, LIVYNQ_ROLE: 'plugin-host' } });
  return fork(fileURLToPath(new URL('./child-entry.ts', import.meta.url)), [], { execArgv: ['--disable-warning=ExperimentalWarning'], stdio, env });
}

function isSea(): boolean {
  try {
    return (process as unknown as { getBuiltinModule(m: string): { isSea(): boolean } }).getBuiltinModule('node:sea').isSea();
  } catch {
    return false;
  }
}
const INVOKE_TIMEOUT_MS = 10_000;

/**
 * Runs a plugin in its own Node process and supervises it: restarts with exponential backoff,
 * marks its devices offline while it is down, and disables it after repeated crashes,
 * so a broken plugin can never stall the hub or the HomeKit bridge.
 */
export class ProcessPluginAdapter implements Adapter {
  readonly id: string;
  readonly #options: Required<Omit<ProcessPluginOptions, 'config'>> & { config: Record<string, unknown> };
  #ctx!: AdapterContext;
  #child: ChildProcess | undefined;
  #status: PluginStatus = 'stopped';
  #stopping = false;
  #restartTimer: NodeJS.Timeout | undefined;
  #crashes: number[] = [];
  #restarts = 0;
  #lastError: string | null = null;
  /** Most recent failure reported by the child before it exits (start error or error log). */
  #lastFailure: string | undefined;
  #startedAt: number | null = null;
  readonly #handles = new Map<string, DeviceHandle>();
  readonly #invokes = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #nextInvoke = 1;
  /** Resolves the pending spawn() promise once the child started, failed or exited. */
  #onStarted: (() => void) | undefined;

  constructor(options: ProcessPluginOptions) {
    this.id = options.id;
    this.#options = {
      maxCrashes: 5,
      crashWindowMs: 10 * 60_000,
      backoffMs: [1000, 2000, 5000, 15_000, 30_000, 60_000],
      config: {},
      ...options,
    };
  }

  info(): PluginRuntimeInfo {
    return {
      id: this.id,
      module: this.#options.module,
      isolation: 'process',
      status: this.#status,
      pid: this.#child?.pid ?? null,
      restarts: this.#restarts,
      lastError: this.#lastError,
      startedAt: this.#startedAt,
      devices: this.#ctx ? this.#ctx.knownDevices().length : 0,
    };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.#ctx = ctx;
    this.#stopping = false;
    this.#crashes = [];
    mkdirSync(ctx.dataDir, { recursive: true });
    // Don't block hub startup on a slow plugin; wait briefly so fast plugins are up before exporters settle.
    await Promise.race([this.#spawn(), new Promise((r) => setTimeout(r, 3000))]);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      this.#status = 'stopped';
      return;
    }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      this.#send({ type: 'stop' });
    });
    this.#status = 'stopped';
  }

  /** Manual restart (UI/CLI); also re-enables a disabled plugin. */
  async restart(): Promise<void> {
    await this.stop();
    this.#stopping = false;
    this.#crashes = [];
    await this.#spawn();
  }

  #send(msg: ParentMessage): void {
    if (this.#child?.connected) this.#child.send(msg);
  }

  #spawn(): Promise<void> {
    this.#status = 'starting';
    this.#lastFailure = undefined;
    const child = spawnHost(this.id);
    this.#child = child;
    const log = this.#ctx.log;
    for (const [stream, level] of [[child.stdout!, 'info'], [child.stderr!, 'warn']] as const) {
      createInterface({ input: stream }).on('line', (line) => log[level]({ stream: level === 'info' ? 'stdout' : 'stderr' }, line));
    }
    const started = new Promise<void>((resolve) => {
      this.#onStarted = () => {
        this.#onStarted = undefined;
        resolve();
      };
    });
    child.on('message', (msg: ChildMessage) => this.#onMessage(msg));
    child.on('exit', (code, signal) => this.#onExit(child, code, signal));
    child.on('error', (err) => log.error({ err: err.message }, 'plugin process error'));
    return started;
  }

  #onMessage(msg: ChildMessage): void {
    const ctx = this.#ctx;
    switch (msg.type) {
      case 'ready': {
        const state: Record<string, StateSnapshot> = {};
        for (const d of ctx.knownDevices()) state[d.id] = ctx.deviceState(d.id);
        this.#send({ type: 'start', module: this.#options.module, pluginId: this.id, config: this.#options.config, dataDir: ctx.dataDir, state });
        return;
      }
      case 'started':
        this.#status = 'running';
        this.#startedAt = Date.now();
        ctx.log.info({ pid: this.#child?.pid }, 'plugin started');
        this.#onStarted?.();
        return;
      case 'startFailed':
        this.#lastFailure = msg.error.split('\n')[0];
        ctx.log.error({ error: msg.error }, 'plugin failed to start');
        this.#onStarted?.();
        this.#child?.kill();
        return;
      case 'request':
        return this.#answer(msg);
      case 'update':
        try {
          this.#handles.get(msg.deviceId)?.update(msg.endpointId, msg.capability, msg.attributes);
        } catch (err) {
          ctx.log.warn({ err: (err as Error).message, deviceId: msg.deviceId }, 'invalid state update from plugin');
        }
        return;
      case 'availability':
        this.#handles.get(msg.deviceId)?.setAvailability(msg.availability);
        return;
      case 'handle': {
        const handle = this.#handles.get(msg.deviceId);
        handle?.handle(msg.endpointId, msg.capability, Object.fromEntries(msg.commands.map((command) => [command, (params: Record<string, unknown>) => this.#invoke(msg.deviceId, msg.endpointId, msg.capability, command, params)])));
        return;
      }
      case 'invokeResult': {
        const p = this.#invokes.get(msg.id);
        if (!p) return;
        this.#invokes.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve();
        else p.reject(new LivynqError('INTERNAL', msg.error));
        return;
      }
      case 'log':
        if (msg.level === 'error') this.#lastFailure = msg.message.split('\n')[0];
        ctx.log[msg.level](msg.data ?? {}, msg.message);
        return;
      case 'stopped':
        return;
    }
  }

  #answer(msg: Extract<ChildMessage, { type: 'request' }>): void {
    const ctx = this.#ctx;
    const reply = (fn: () => unknown) => {
      try {
        this.#send({ type: 'response', id: msg.id, ok: true, value: fn() });
      } catch (err) {
        this.#send({ type: 'response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    switch (msg.method) {
      case 'upsertDevice':
        return reply(() => {
          this.#handles.set(msg.def.id, ctx.upsertDevice(msg.def));
          return undefined;
        });
      case 'removeDevice':
        return reply(() => {
          ctx.removeDevice(msg.deviceId);
          this.#handles.delete(msg.deviceId);
          return undefined;
        });
      case 'knownDevices':
        return reply(() => ctx.knownDevices());
      case 'deviceExists':
        return reply(() => ctx.deviceExists(msg.deviceId));
      case 'endpointId':
        return reply(() => ctx.endpointId(msg.deviceId, msg.key));
    }
  }

  #invoke(deviceId: string, endpointId: number, capability: string, command: string, params: Record<string, unknown>): Promise<void> {
    if (this.#status !== 'running') return Promise.reject(new LivynqError('DEVICE_OFFLINE', `Plugin ${this.id} is ${this.#status}`));
    const id = this.#nextInvoke++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#invokes.delete(id);
        reject(new LivynqError('TIMEOUT', `Plugin ${this.id} did not answer`));
      }, INVOKE_TIMEOUT_MS);
      this.#invokes.set(id, { resolve, reject, timer });
      this.#send({ type: 'invoke', id, deviceId, endpointId, capability, command, params });
    });
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.#child) return;
    this.#child = undefined;
    for (const [id, p] of this.#invokes) {
      clearTimeout(p.timer);
      p.reject(new LivynqError('DEVICE_OFFLINE', `Plugin ${this.id} stopped`));
      this.#invokes.delete(id);
    }
    for (const device of this.#ctx.knownDevices()) this.#handles.get(device.id)?.setAvailability('offline');
    this.#onStarted?.();
    if (this.#stopping) {
      this.#status = 'stopped';
      return;
    }
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter((t) => now - t < this.#options.crashWindowMs), now];
    this.#lastError = this.#lastFailure ?? `exited with ${signal ?? code}`;
    if (this.#crashes.length >= this.#options.maxCrashes) {
      this.#status = 'disabled';
      this.#ctx.log.error({ crashes: this.#crashes.length }, 'plugin crashed repeatedly and was disabled; fix it and restart it from the UI or CLI');
      return;
    }
    this.#status = 'crashed';
    const delay = this.#options.backoffMs[Math.min(this.#crashes.length - 1, this.#options.backoffMs.length - 1)]!;
    this.#ctx.log.warn({ code, signal, retryInMs: delay }, 'plugin process exited; restarting');
    this.#restartTimer = setTimeout(() => {
      this.#restarts++;
      void this.#spawn();
    }, delay);
  }
}
