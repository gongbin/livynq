import { randomUUID } from 'node:crypto';
import type { DeviceId, Level, Placement, Room } from '@livynq/model';
import { LivynqError } from './errors.ts';
import type { EventBus } from './event-bus.ts';
import type { Registry } from './registry.ts';
import type { Storage } from './storage.ts';

export interface FloorPlan {
  levels: Level[];
  rooms: Room[];
  placements: { deviceId: DeviceId; placement: Placement }[];
}

const MAX_SCENE_BYTES = 5 * 1024 * 1024;

/**
 * Floors, room outlines and device positions (design doc §16): the data behind the 2D floor plan,
 * the 3D view and spatial reasoning for agents/automations. Rendering-agnostic; 3D scene documents
 * (e.g. Pascal Editor JSON) are stored per level as opaque attachments.
 */
export class Spaces {
  readonly #storage: Storage;
  readonly #bus: EventBus;
  readonly #registry: Registry;
  readonly #levels = new Map<string, Level>();

  constructor(storage: Storage, bus: EventBus, registry: Registry) {
    this.#storage = storage;
    this.#bus = bus;
    this.#registry = registry;
    for (const r of this.#storage.sql('SELECT * FROM levels').all() as Record<string, string | number | null>[]) {
      this.#levels.set(String(r.id), { id: String(r.id), name: String(r.name), sortOrder: Number(r.sort_order), elevation: Number(r.elevation), background: r.background ? JSON.parse(String(r.background)) : null });
    }
  }

  listLevels(): Level[] {
    return [...this.#levels.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.elevation - b.elevation);
  }

  getLevel(id: string): Level {
    const level = this.#levels.get(id);
    if (!level) throw new LivynqError('NOT_FOUND', `Level not found: ${id}`);
    return level;
  }

  createLevel(input: { name: string; elevation?: number }): Level {
    const name = input.name?.trim();
    if (!name) throw new LivynqError('INVALID_PARAMS', 'Level name must not be empty');
    const level: Level = { id: randomUUID(), name, sortOrder: this.#levels.size, elevation: Number(input.elevation ?? this.#levels.size * 3), background: null };
    this.#save(level);
    return level;
  }

  updateLevel(id: string, patch: Partial<Pick<Level, 'name' | 'elevation' | 'sortOrder' | 'background'>>): Level {
    const level = { ...this.getLevel(id), ...patch };
    if (!level.name.trim()) throw new LivynqError('INVALID_PARAMS', 'Level name must not be empty');
    this.#save(level);
    return level;
  }

  deleteLevel(id: string): void {
    this.getLevel(id);
    for (const room of this.#registry.listRooms()) if (room.levelId === id) this.#registry.updateRoom(room.id, { levelId: null, polygon: null });
    for (const device of this.#registry.listDevices()) if (device.placement?.levelId === id) this.#registry.updateDevice(device.id, { placement: null });
    this.#storage.sql('DELETE FROM levels WHERE id = ?').run(id);
    this.#storage.sql('DELETE FROM scene_documents WHERE level_id = ?').run(id);
    this.#levels.delete(id);
    this.#bus.emit('levels.changed', this.listLevels());
  }

  #save(level: Level): void {
    this.#storage
      .sql(
        `INSERT INTO levels (id, name, sort_order, elevation, background) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, elevation = excluded.elevation, background = excluded.background`,
      )
      .run(level.id, level.name, level.sortOrder, level.elevation, level.background ? JSON.stringify(level.background) : null);
    this.#levels.set(level.id, level);
    this.#bus.emit('levels.changed', this.listLevels());
  }

  floorPlan(): FloorPlan {
    return {
      levels: this.listLevels(),
      rooms: this.#registry.listRooms(),
      placements: this.#registry
        .listDevices()
        .filter((d) => d.placement)
        .map((d) => ({ deviceId: d.id, placement: d.placement! })),
    };
  }

  /**
   * Places (or removes, with null) a device on the floor plan. Dropping it inside a room's outline
   * also assigns it to that room.
   */
  place(deviceId: DeviceId, placement: Placement | null): { roomId: string | null } {
    const device = this.#registry.requireDevice(deviceId);
    if (placement) this.getLevel(placement.levelId);
    const room = placement ? this.roomAt(placement.levelId, placement.x, placement.y) : undefined;
    this.#registry.updateDevice(deviceId, { placement, ...(room ? { roomId: room.id } : {}) });
    return { roomId: room?.id ?? device.roomId };
  }

  roomAt(levelId: string, x: number, y: number): Room | undefined {
    return this.#registry.listRooms().find((r) => r.levelId === levelId && r.polygon && pointInPolygon(x, y, r.polygon));
  }

  getScene(levelId: string): { data: unknown; updatedAt: number } | null {
    this.getLevel(levelId);
    const row = this.#storage.sql('SELECT data, updated_at FROM scene_documents WHERE level_id = ?').get(levelId) as { data: string; updated_at: number } | undefined;
    return row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
  }

  putScene(levelId: string, data: unknown): { updatedAt: number } {
    this.getLevel(levelId);
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > MAX_SCENE_BYTES) throw new LivynqError('INVALID_PARAMS', 'Scene document larger than 5 MB');
    const updatedAt = Date.now();
    this.#storage
      .sql('INSERT INTO scene_documents (level_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(level_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(levelId, json, updatedAt);
    return { updatedAt };
  }

  /** Rooms sharing a wall (an edge segment overlapping within 5 cm): used for agent spatial reasoning. */
  adjacency(): Record<string, string[]> {
    const rooms = this.#registry.listRooms().filter((r) => r.polygon && r.levelId);
    const out: Record<string, string[]> = {};
    for (const a of rooms) {
      out[a.id] = rooms.filter((b) => b.id !== a.id && b.levelId === a.levelId && sharesEdge(a.polygon!, b.polygon!)).map((b) => b.id);
    }
    return out;
  }
}

export function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(polygon: [number, number][]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) sum += (polygon[j]![0] + polygon[i]![0]) * (polygon[j]![1] - polygon[i]![1]);
  return Math.abs(sum / 2);
}

function sharesEdge(a: [number, number][], b: [number, number][], eps = 0.05): boolean {
  const edges = (p: [number, number][]) => p.map((pt, i) => [pt, p[(i + 1) % p.length]!] as const);
  for (const [a1, a2] of edges(a)) {
    for (const [b1, b2] of edges(b)) {
      // collinear (both b points close to line a) and overlapping projections
      const dx = a2[0] - a1[0];
      const dy = a2[1] - a1[1];
      const len = Math.hypot(dx, dy);
      if (len < eps) continue;
      const dist = (p: readonly [number, number]) => Math.abs(dy * (p[0] - a1[0]) - dx * (p[1] - a1[1])) / len;
      if (dist(b1) > eps || dist(b2) > eps) continue;
      const t = (p: readonly [number, number]) => ((p[0] - a1[0]) * dx + (p[1] - a1[1]) * dy) / (len * len);
      const [lo, hi] = [Math.min(t(b1), t(b2)), Math.max(t(b1), t(b2))];
      if (Math.min(1, hi) - Math.max(0, lo) > eps / len) return true;
    }
  }
  return false;
}
