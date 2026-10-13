/**
 * Plugin host process entry point. Loads one plugin module and implements the SDK's
 * PluginContext over IPC with the hub. A crash here never takes the hub down.
 */
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { isPluginDefinition, type CommandHandler, type PluginContext, type PluginDevice } from '@livynq/sdk';
import type { AttributeValue, Device, DeviceDefinition } from '@livynq/model';
import type { ChildMessage, ParentMessage, StateSnapshot } from './protocol.ts';

/** Runs the plugin host in this process (forked child, or the SEA binary relaunched with LIVYNQ_ROLE=plugin-host). */
export function runPluginHost(): void {
  if (!process.send) {
    console.error('plugin host must be started by the Livynq hub');
    process.exit(1);
  }

  const send = (msg: ChildMessage) => process.send!(msg);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handlers = new Map<string, Record<string, CommandHandler>>();
  const actions = new Map<string, (params: Record<string, unknown>) => unknown>();
  const state = new Map<string, StateSnapshot>();
  const stopHooks: (() => void | Promise<void>)[] = [];
  let nextId = 1;

  type RequestMessage = Extract<ChildMessage, { type: 'request' }>;
  type RequestBody = RequestMessage extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

  function request<T>(msg: RequestBody): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send({ ...msg, id } as ChildMessage);
    });
  }

  function setLocal(deviceId: string, endpointId: number, capability: string, attributes: Record<string, AttributeValue>): void {
    let s = state.get(deviceId);
    if (!s) state.set(deviceId, (s = {}));
    const cap = ((s[endpointId] ??= {})[capability] ??= {});
    Object.assign(cap, attributes);
  }

  function deviceHandle(id: string): PluginDevice {
    return {
      id,
      update(endpointId, capability, attributes) {
        setLocal(id, endpointId, capability, attributes);
        send({ type: 'update', deviceId: id, endpointId, capability, attributes });
      },
      get: (endpointId, capability, attribute) => state.get(id)?.[endpointId]?.[capability]?.[attribute],
      setAvailability: (availability) => send({ type: 'availability', deviceId: id, availability }),
      handle(endpointId, capability, map) {
        handlers.set(`${id}/${endpointId}/${capability}`, map);
        send({ type: 'handle', deviceId: id, endpointId, capability, commands: Object.keys(map) });
      },
    };
  }

  const log = (level: 'debug' | 'info' | 'warn' | 'error') => (message: string, data?: Record<string, unknown>) => send({ type: 'log', level, message, data });

  async function start(msg: Extract<ParentMessage, { type: 'start' }>): Promise<void> {
    for (const [deviceId, snapshot] of Object.entries(msg.state)) state.set(deviceId, snapshot);
    const ctx: PluginContext = {
      pluginId: msg.pluginId,
      log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
      config: msg.config,
      dataDir: msg.dataDir,
      devices: {
        upsert: async (def: DeviceDefinition) => {
          await request({ type: 'request', method: 'upsertDevice', def });
          return deviceHandle(def.id);
        },
        remove: (deviceId: string) => request({ type: 'request', method: 'removeDevice', deviceId }),
        known: () => request<Device[]>({ type: 'request', method: 'knownDevices' }),
        exists: (deviceId: string) => request<boolean>({ type: 'request', method: 'deviceExists', deviceId }),
      },
      endpointId: (deviceId: string, key: string) => request<number>({ type: 'request', method: 'endpointId', deviceId, key }),
      onStop: (fn) => void stopHooks.push(fn),
      actions: {
        register: (name, description, handler) => {
          actions.set(name, handler);
          send({ type: 'registerAction', name, description });
        },
      },
    };
    const url = isAbsolute(msg.module) ? pathToFileURL(msg.module).href : msg.module;
    const mod = (await import(url)) as { default?: unknown };
    if (!isPluginDefinition(mod.default)) throw new Error(`${msg.module} must default-export defineAdapter({...}) from @livynq/sdk`);
    await mod.default.setup(ctx);
  }

  process.on('message', async (msg: ParentMessage) => {
    switch (msg.type) {
      case 'start':
        try {
          await start(msg);
          send({ type: 'started' });
        } catch (err) {
          send({ type: 'startFailed', error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        }
        return;
      case 'response': {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.value);
        else p?.reject(new Error(msg.error));
        return;
      }
      case 'invoke': {
        const handler = handlers.get(`${msg.deviceId}/${msg.endpointId}/${msg.capability}`)?.[msg.command];
        try {
          if (!handler) throw new Error(`No handler for ${msg.capability}.${msg.command}`);
          await handler(msg.params);
          send({ type: 'invokeResult', id: msg.id, ok: true });
        } catch (err) {
          send({ type: 'invokeResult', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'action': {
        const handler = actions.get(msg.name);
        try {
          if (!handler) throw new Error(`Unknown action ${msg.name}`);
          const value = await handler(msg.params);
          send({ type: 'actionResult', id: msg.id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) });
        } catch (err) {
          send({ type: 'actionResult', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'stop':
        for (const hook of stopHooks.splice(0)) {
          try {
            await hook();
          } catch {
            // best effort
          }
        }
        send({ type: 'stopped' });
        setTimeout(() => process.exit(0), 50);
        return;
    }
  });

  process.on('uncaughtException', (err) => {
    send({ type: 'log', level: 'error', message: `uncaught exception: ${err.stack ?? err.message}` });
    process.exit(70);
  });
  process.on('unhandledRejection', (err) => {
    send({ type: 'log', level: 'error', message: `unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` });
    process.exit(70);
  });
  // The hub went away: nothing left to serve.
  process.on('disconnect', () => process.exit(0));

  send({ type: 'ready' });
}
