import { EventEmitter } from 'node:events';
import type { Availability, Device, DeviceId, Level, Room, StateChange } from '@livynq/model';
import type { Confirmation } from './confirmations.ts';

export interface HomeEvents {
  'device.added': Device;
  'device.updated': Device;
  'device.removed': { id: DeviceId };
  availability: { deviceId: DeviceId; availability: Availability };
  state: StateChange;
  'rooms.changed': Room[];
  confirmation: Confirmation;
  settings: { key: string; value: unknown };
  'levels.changed': Level[];
}

export type HomeEventName = keyof HomeEvents;

/** Typed, synchronous event bus. Listener errors are isolated so one bad subscriber cannot break dispatch. */
export class EventBus {
  readonly #emitter = new EventEmitter({ captureRejections: false });
  readonly #onError: (err: unknown, event: string) => void;

  constructor(onError: (err: unknown, event: string) => void = () => {}) {
    this.#emitter.setMaxListeners(0);
    this.#onError = onError;
  }

  on<E extends HomeEventName>(event: E, listener: (payload: HomeEvents[E]) => void): () => void {
    const wrapped = (payload: HomeEvents[E]) => {
      try {
        listener(payload);
      } catch (err) {
        this.#onError(err, event);
      }
    };
    this.#emitter.on(event, wrapped);
    return () => this.#emitter.off(event, wrapped);
  }

  /** Subscribes to every event; used by the WebSocket API. */
  onAny(listener: <E extends HomeEventName>(event: E, payload: HomeEvents[E]) => void): () => void {
    const names: HomeEventName[] = ['device.added', 'device.updated', 'device.removed', 'availability', 'state', 'rooms.changed', 'confirmation', 'settings', 'levels.changed'];
    const offs = names.map((name) => this.on(name, (payload) => listener(name, payload)));
    return () => offs.forEach((off) => off());
  }

  emit<E extends HomeEventName>(event: E, payload: HomeEvents[E]): void {
    this.#emitter.emit(event, payload);
  }
}
