import type { DeviceDTO, Level, Placement, Room } from '@livynq/model';
import { deviceKind, readings, type DeviceKind } from './devices.ts';
import { readLocal, writeLocal } from './store.ts';

/** Floor plan coordinates are meters; x grows right, y grows down (SVG-like). In 3D y becomes z. */
export type Pt = [number, number];

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const GRID = 0.1;
export const snap = (v: number, step = GRID) => Math.round(v / step) * step;
export const snapPt = (p: Pt): Pt => [round2(snap(p[0])), round2(snap(p[1]))];
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function polygonArea(p: Pt[]): number {
  let sum = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) sum += (p[j]![0] + p[i]![0]) * (p[j]![1] - p[i]![1]);
  return Math.abs(sum / 2);
}

export function centroid(p: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const f = p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
    a += f;
    cx += (p[j]![0] + p[i]![0]) * f;
    cy += (p[j]![1] + p[i]![1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const b = boundsOf(p);
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(x: number, y: number, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function boundsOf(points: Pt[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  }
  return b;
}

export const rectPolygon = (a: Pt, b: Pt): Pt[] => {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
};

/** Where a room's name label sits: near the top-left corner like the prototype, or the centroid for odd shapes. */
export function labelAnchor(p: Pt[]): Pt {
  const b = boundsOf(p);
  const corner: Pt = [b.minX + 0.25, b.minY + 0.25];
  return pointInPolygon(corner[0], corner[1], p) && pointInPolygon(corner[0] + 1, corner[1] + 0.5, p) ? corner : centroid(p);
}

// --------------------------------------------------------------------------- rooms & devices on a level

export const roomsOn = (rooms: Room[], levelId: string | undefined) => rooms.filter((r) => r.levelId === levelId && r.polygon && r.polygon.length >= 3);

export function placedOn(devices: DeviceDTO[], levelId: string | undefined): (DeviceDTO & { placement: Placement })[] {
  return devices.filter((d): d is DeviceDTO & { placement: Placement } => !!d.placement && d.placement.levelId === levelId);
}

/** Extent of everything drawn on a level (rooms, devices, background image). */
export function levelBounds(level: Level | undefined, rooms: Room[], devices: DeviceDTO[], bgAspect?: number): Bounds | null {
  const pts: Pt[] = [];
  for (const r of roomsOn(rooms, level?.id)) pts.push(...r.polygon!);
  for (const d of placedOn(devices, level?.id)) pts.push([d.placement.x, d.placement.y]);
  if (level?.background && bgAspect) pts.push([0, 0], [level.background.widthMeters, level.background.widthMeters / bgAspect]);
  return pts.length ? boundsOf(pts) : null;
}

/** Soft room fills; stored as hex so the 3D view (three.Color) can use them too. */
export const ROOM_COLORS = ['#e9c9a0', '#cfdcb4', '#b9d3e0', '#e3c0c8', '#d4c8e6', '#f0dfa6', '#c4ddd0', '#ddd2c4'] as const;

export function roomColor(room: Room, index: number): string {
  return room.color ?? ROOM_COLORS[index % ROOM_COLORS.length]!;
}

/** First temperature reading in the room (thermostat or sensor), for the room label. */
export function roomTemperature(roomId: string, devices: DeviceDTO[]): number | undefined {
  for (const d of devices) {
    if (d.roomId !== roomId || d.availability === 'offline') continue;
    const r = readings(d).find((x) => x.capability === 'temperatureMeasurement' || (x.capability === 'thermostat' && x.attribute === 'localTemperature'));
    if (r) return r.value;
  }
  return undefined;
}

// --------------------------------------------------------------------------- 3D heights

export const WALL_HEIGHT = 2.6;
const MOUNT_Z = { ceiling: 2.5, wall: 1.4, floor: 0.3, furniture: 0.8 } as const;

/** Sensible mount for a newly placed device. */
export function defaultMount(kind: DeviceKind): NonNullable<Placement['mount']> {
  switch (kind) {
    case 'light':
      return 'ceiling';
    case 'plug':
    case 'leak':
      return 'floor';
    case 'fan':
    case 'button':
      return 'furniture';
    default:
      return 'wall';
  }
}

export function placementHeight(p: Placement, d?: DeviceDTO): number {
  if (typeof p.z === 'number') return p.z;
  const mount = p.mount ?? (d ? defaultMount(deviceKind(d)) : 'floor');
  return MOUNT_Z[mount];
}

// --------------------------------------------------------------------------- auto layout

export interface AutoLayout {
  rooms: { id: string; polygon: Pt[] }[];
  placements: { deviceId: string; x: number; y: number }[];
}

/**
 * Quick start: a rectangle per room in a compact grid (shared walls), roughly sized by device count,
 * with each room's devices spread inside it. Users then adjust instead of starting from nothing.
 */
export function autoLayout(rooms: Room[], devices: DeviceDTO[], originY = 0): AutoLayout {
  const out: AutoLayout = { rooms: [], placements: [] };
  if (!rooms.length) return out;
  const cols = Math.ceil(Math.sqrt(rooms.length));
  const w = 4.4;
  const h = 3.6;
  rooms.forEach((room, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = col * w;
    const y0 = originY + row * h;
    out.rooms.push({ id: room.id, polygon: rectPolygon([x0, y0], [x0 + w, y0 + h]) });
    const inRoom = devices.filter((d) => d.roomId === room.id && !d.placement);
    const per = Math.max(1, Math.ceil(Math.sqrt(inRoom.length * (w / h))));
    const rows = Math.max(1, Math.ceil(inRoom.length / per));
    inRoom.forEach((d, k) => {
      const c = k % per;
      const r = Math.floor(k / per);
      out.placements.push({ deviceId: d.id, x: round2(x0 + ((c + 0.5) * w) / per), y: round2(y0 + 0.5 + ((r + 0.5) * (h - 0.6)) / rows) });
    });
  });
  return out;
}

// --------------------------------------------------------------------------- per-viewer preferences

/** 3D level selector value showing every floor stacked. */
export const ALL_LEVELS = '__all';

export type HomeView = 'cards' | 'plan' | '3d';
const VIEWS: HomeView[] = ['cards', 'plan', '3d'];

export function readView(key: string, fallback: HomeView = 'cards'): HomeView {
  const v = readLocal(key);
  return VIEWS.includes(v as HomeView) ? (v as HomeView) : fallback;
}

export const writeView = (key: string, v: HomeView) => writeLocal(key, v);

/** Tracing image opacity (per level, per browser). */
export function bgOpacity(levelId: string): number {
  const v = Number(readLocal(`livynq.plan.bgOpacity.${levelId}`));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
}

export const setBgOpacity = (levelId: string, v: number) => writeLocal(`livynq.plan.bgOpacity.${levelId}`, String(v));

export function readLevelChoice(key: string): string | null {
  return readLocal(key);
}

export const writeLevelChoice = (key: string, id: string) => writeLocal(key, id);

export function formatMeters(v: number): string {
  return `${(Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '')} m`;
}

export function formatArea(v: number): string {
  return `${(Math.round(v * 10) / 10).toFixed(1)} m²`;
}
