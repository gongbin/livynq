import type { AttributeValue, CommandBody, DeviceDTO, Level, Room, WsClientMessage, WsServerMessage } from '@livynq/model';
import { ApiError, api, auth } from './api.ts';
import { AwaitingApproval, clearConfirmations, loadPendingConfirmations, upsertConfirmation } from './confirmations.ts';
import { createStore, useStore } from './store.ts';
import { clearWallSettings, loadWallSettings, wallSettings } from './wall-settings.ts';

export type LinkStatus = 'connecting' | 'open' | 'closed';

export interface LiveState {
  status: LinkStatus;
  /** True once the first snapshot has arrived. */
  ready: boolean;
  devices: Record<string, DeviceDTO>;
  rooms: Room[];
  /** Floors of the floor plan; `null` until the first snapshot. */
  levels: Level[] | null;
  /** Keys (see pendingKey) of commands waiting for the device to report back. */
  pending: ReadonlySet<string>;
}

const initial: LiveState = { status: 'connecting', ready: false, devices: {}, rooms: [], levels: null, pending: new Set() };
export const live = createStore<LiveState>(initial);
export const useLive = () => useStore(live);

export const pendingKey = (deviceId: string, endpointId: number, capability: string) => `${deviceId}#${endpointId}/${capability}`;

const sortRooms = (rooms: Room[]) => [...rooms].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
const sortLevels = (levels: Level[]) => [...levels].sort((a, b) => a.sortOrder - b.sortOrder || a.elevation - b.elevation);

/** Applies a level returned by a REST call right away (the socket echo follows). */
export function upsertLevel(level: Level): void {
  live.set((s) => ({ ...s, levels: sortLevels([...(s.levels ?? []).filter((l) => l.id !== level.id), level]) }));
}

/** Applies a room returned by a REST call right away (the socket echo follows). */
export function upsertRoom(room: Room): void {
  live.set((s) => ({ ...s, rooms: sortRooms([...s.rooms.filter((r) => r.id !== room.id), room]) }));
}

// --------------------------------------------------------------------------- pending commands
//
// No optimistic UI: a control stays "pending" until the device reports the new state.
// A command is settled when its result arrives *and* a state event for the same
// capability was seen. Devices that ack but never report (value unchanged) are settled
// by a short grace timer after the result.

interface Pending {
  key: string;
  stateSeen: boolean;
  resolved: boolean;
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const SETTLE_GRACE_MS = 2500;
const RESULT_TIMEOUT_MS = 15_000;
const inflight = new Map<number, Pending>();
let nextId = 1;

function recomputePending(): void {
  live.set((s) => ({ ...s, pending: new Set([...inflight.values()].map((p) => p.key)) }));
}

function settle(id: number, err?: Error): void {
  const p = inflight.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  inflight.delete(id);
  if (err) p.reject(err);
  else p.resolve();
  recomputePending();
}

function onResult(id: number, ok: boolean, err?: Error): void {
  const p = inflight.get(id);
  if (!p) return;
  if (!ok) return settle(id, err);
  if (p.stateSeen) return settle(id);
  p.resolved = true;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => settle(id), SETTLE_GRACE_MS);
}

function onStateFor(key: string): void {
  for (const [id, p] of inflight) {
    if (p.key !== key) continue;
    p.stateSeen = true;
    if (p.resolved) settle(id);
  }
}

/** Sends a device command over the socket (REST fallback). Resolves once the device reported back. */
export function sendCommand(deviceId: string, endpointId: number, body: CommandBody): Promise<void> {
  const id = nextId++;
  const key = pendingKey(deviceId, endpointId, body.capability);
  return new Promise<void>((resolve, reject) => {
    const p: Pending = { key, stateSeen: false, resolved: false, resolve, reject };
    inflight.set(id, p);
    recomputePending();
    p.timer = setTimeout(() => settle(id, new Error('Timed out waiting for the device')), RESULT_TIMEOUT_MS);
    if (socket?.readyState === WebSocket.OPEN) {
      const msg: WsClientMessage = { type: 'command', id, deviceId, endpointId, ...body };
      socket.send(JSON.stringify(msg));
    } else {
      api.command(deviceId, endpointId, body).then(
        (res) => (res.ok ? onResult(id, true) : onResult(id, false, new AwaitingApproval(res.confirmation.id, res.confirmation.summary))),
        (e: unknown) => onResult(id, false, e instanceof Error ? e : new Error(String(e))),
      );
    }
  });
}

// --------------------------------------------------------------------------- socket

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let wanted = false;

function apply(msg: WsServerMessage): void {
  switch (msg.type) {
    case 'snapshot':
      live.set((s) => ({ ...s, ready: true, devices: Object.fromEntries(msg.devices.map((d) => [d.id, d])), rooms: sortRooms(msg.rooms), levels: sortLevels(msg.levels) }));
      // A (re)connect may have missed live updates: resync what is not part of the snapshot.
      void loadPendingConfirmations();
      void loadWallSettings();
      return;
    case 'device':
      live.set((s) => ({ ...s, devices: { ...s.devices, [msg.device.id]: msg.device } }));
      return;
    case 'device.removed':
      live.set((s) => {
        const { [msg.id]: _removed, ...rest } = s.devices;
        return { ...s, devices: rest };
      });
      return;
    case 'availability':
      live.set((s) => {
        const d = s.devices[msg.deviceId];
        return d ? { ...s, devices: { ...s.devices, [d.id]: { ...d, availability: msg.availability } } } : s;
      });
      return;
    case 'rooms':
      live.set((s) => ({ ...s, rooms: sortRooms(msg.rooms) }));
      return;
    case 'levels':
      live.set((s) => ({ ...s, levels: sortLevels(msg.levels) }));
      return;
    case 'state':
      live.set((s) => {
        const d = s.devices[msg.deviceId];
        if (!d) return s;
        const ep = d.state[msg.endpointId] ?? {};
        const cap = ep[msg.capability] ?? {};
        const state = { ...d.state, [msg.endpointId]: { ...ep, [msg.capability]: { ...cap, [msg.attribute]: msg.value as AttributeValue } } };
        return { ...s, devices: { ...s.devices, [d.id]: { ...d, state } } };
      });
      onStateFor(pendingKey(msg.deviceId, msg.endpointId, msg.capability));
      return;
    case 'confirmation':
      upsertConfirmation(msg.confirmation);
      return;
    case 'settings':
      wallSettings.set(msg.wall);
      return;
    case 'result':
      if (msg.ok) onResult(msg.id, true);
      else if (msg.error.code === 'CONFIRMATION_REQUIRED' && msg.error.hint) onResult(msg.id, false, new AwaitingApproval(msg.error.hint, msg.error.message));
      else onResult(msg.id, false, new ApiError(0, msg.error));
      return;
  }
}

function open(): void {
  const token = auth.get();
  if (!token || !wanted) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/v1/ws?token=${encodeURIComponent(token)}`);
  socket = ws;
  let opened = false;
  live.set((s) => ({ ...s, status: 'connecting' }));
  ws.onopen = () => {
    opened = true;
    retry = 0;
    live.set((s) => ({ ...s, status: 'open' }));
  };
  ws.onmessage = (ev) => {
    try {
      apply(JSON.parse(String(ev.data)) as WsServerMessage);
    } catch {
      // ignore malformed frames
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    live.set((s) => ({ ...s, status: 'closed' }));
    // A failed upgrade may mean the token was revoked; a REST call surfaces the 401 (→ login).
    if (!opened) void api.me().catch(() => undefined);
    if (!wanted) return;
    const delay = Math.min(30_000, 500 * 2 ** retry) * (0.75 + Math.random() * 0.5);
    retry++;
    retryTimer = setTimeout(open, delay);
  };
}

export function connectLive(): void {
  if (wanted) return;
  wanted = true;
  retry = 0;
  open();
}

export function disconnectLive(): void {
  wanted = false;
  clearTimeout(retryTimer);
  const ws = socket;
  socket = null;
  ws?.close();
  for (const id of [...inflight.keys()]) settle(id, new Error('Disconnected'));
  live.set(initial);
  clearConfirmations();
  clearWallSettings();
}

// Reconnect promptly when a phone/tablet wakes up or the network returns.
if (typeof window !== 'undefined') {
  const nudge = () => {
    if (wanted && !socket) {
      clearTimeout(retryTimer);
      retry = 0;
      open();
    }
  };
  window.addEventListener('online', nudge);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && nudge());
}
