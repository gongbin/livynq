import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DeviceDTO, Level, Room } from '@livynq/model';
import { withToken } from '../../lib/api.ts';
import { lightState, glowColor, deviceKind, round1 } from '../../lib/devices.ts';
import { labelAnchor, placedOn, pointInPolygon, roomColor, roomTemperature, type Pt } from '../../lib/floorplan.ts';
import type { View } from './use-pan-zoom.ts';

/** Natural aspect ratio (w/h) of a level's tracing image, once loaded. */
export function useBackground(level: Level | undefined): { url: string | null; aspect: number | undefined } {
  const url = level?.background ? withToken(level.background.url) : null;
  const [aspect, setAspect] = useState<{ url: string; aspect: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => img.naturalWidth && img.naturalHeight && setAspect({ url, aspect: img.naturalWidth / img.naturalHeight });
    img.src = url;
  }, [url]);
  return { url, aspect: aspect && aspect.url === url ? aspect.aspect : undefined };
}

export interface SurfaceRoom {
  room: Room;
  polygon: Pt[];
  index: number;
}

/** Rooms with an outline on this level, keeping a stable color index (order in the room list). */
export function surfaceRooms(rooms: Room[], levelId: string | undefined, overrides?: Record<string, Pt[] | undefined>): SurfaceRoom[] {
  const out: SurfaceRoom[] = [];
  rooms.forEach((room, index) => {
    const polygon = overrides?.[room.id] ?? (room.levelId === levelId ? room.polygon : null);
    if (polygon && polygon.length >= 3) out.push({ room, polygon, index });
  });
  return out;
}

interface Glow {
  id: string;
  x: number;
  y: number;
  r: number;
  color: string;
  alpha: number;
  roomId?: string;
}

export function lightGlows(devices: DeviceDTO[], levelId: string | undefined, rooms: SurfaceRoom[]): Glow[] {
  const out: Glow[] = [];
  for (const d of placedOn(devices, levelId)) {
    if (deviceKind(d) !== 'light' || d.availability === 'offline') continue;
    const l = lightState(d);
    const color = glowColor(l);
    if (!l?.on || !color) continue;
    const pct = l.percent ?? 100;
    const { x, y } = d.placement;
    out.push({ id: d.id, x, y, r: 1.3 + (2.2 * pct) / 100, color, alpha: 0.28 + pct / 200, roomId: rooms.find((r) => pointInPolygon(x, y, r.polygon))?.room.id });
  }
  return out;
}

const pts = (p: Pt[]) => p.map(([x, y]) => `${x},${y}`).join(' ');

/**
 * The SVG part of the plan: tracing image, room floors (tinted, brighter where a light is on),
 * light glows clipped to their room, and walls. Everything in meters under the view transform.
 */
export function PlanSvg({
  view,
  level,
  rooms,
  devices,
  background,
  bgOpacity = 0.5,
  selectedRoomId,
  onRoomPointerDown,
  children,
}: {
  view: View;
  level: Level | undefined;
  rooms: SurfaceRoom[];
  devices: DeviceDTO[];
  background?: { url: string | null; aspect: number | undefined } | null;
  bgOpacity?: number;
  selectedRoomId?: string | null;
  onRoomPointerDown?: (roomId: string, e: ReactPointerEvent<SVGPolygonElement>) => void;
  children?: React.ReactNode;
}) {
  const glows = useMemo(() => lightGlows(devices, level?.id, rooms), [devices, level?.id, rooms]);
  const lit = new Set(glows.map((g) => g.roomId));
  const bg = background?.url && background.aspect && level?.background ? { url: background.url, w: level.background.widthMeters, h: level.background.widthMeters / background.aspect } : null;
  const transform = `translate(${view.x} ${view.y}) scale(${view.k})`;

  return (
    <svg className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
      <defs>
        {rooms.map((r) => (
          <clipPath key={r.room.id} id={`lv-clip-${r.room.id}`}>
            <polygon points={pts(r.polygon)} />
          </clipPath>
        ))}
        {glows.map((g) => (
          <radialGradient key={g.id} id={`lv-glow-${g.id}`}>
            <stop offset="0%" style={{ stopColor: g.color, stopOpacity: g.alpha }} />
            <stop offset="45%" style={{ stopColor: g.color, stopOpacity: g.alpha * 0.45 }} />
            <stop offset="100%" style={{ stopColor: g.color, stopOpacity: 0 }} />
          </radialGradient>
        ))}
      </defs>
      <g transform={transform}>
        {bg && <image href={bg.url} x={0} y={0} width={bg.w} height={bg.h} opacity={bgOpacity} preserveAspectRatio="none" />}
        {rooms.map((r) => {
          const color = roomColor(r.room, r.index);
          const on = lit.has(r.room.id);
          return (
            <polygon
              key={r.room.id}
              points={pts(r.polygon)}
              onPointerDown={onRoomPointerDown ? (e) => onRoomPointerDown(r.room.id, e) : undefined}
              style={{
                fill: `color-mix(in oklab, ${color} var(--glow-mix), ${on ? 'var(--floor-lit)' : 'var(--floor)'})`,
                fillOpacity: bg ? 0.82 : 1,
                transition: 'fill 400ms',
                cursor: onRoomPointerDown ? 'pointer' : undefined,
              }}
            />
          );
        })}
        {glows.map((g) => (
          <g key={g.id} clipPath={g.roomId ? `url(#lv-clip-${g.roomId})` : undefined} pointerEvents="none">
            <circle cx={g.x} cy={g.y} r={g.r} fill={`url(#lv-glow-${g.id})`} />
          </g>
        ))}
        {rooms.map((r) => (
          <polygon
            key={r.room.id}
            points={pts(r.polygon)}
            fill="none"
            pointerEvents="none"
            stroke={r.room.id === selectedRoomId ? 'var(--amber-ink)' : 'var(--wall)'}
            strokeWidth={r.room.id === selectedRoomId ? 3.5 : 3}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {children}
      </g>
    </svg>
  );
}

/** CSS background that draws a 1 m grid (5 m when zoomed out) in step with the view. */
export function gridStyle(view: View, kind: 'dots' | 'lines'): React.CSSProperties {
  const step = (view.k < 14 ? 5 : 1) * view.k;
  const c = 'color-mix(in oklab, var(--wall) 20%, transparent)';
  return {
    backgroundImage: kind === 'dots' ? `radial-gradient(circle, ${c} 1px, transparent 1.3px)` : `linear-gradient(to right, ${c} 1px, transparent 1px), linear-gradient(to bottom, ${c} 1px, transparent 1px)`,
    backgroundSize: `${step}px ${step}px`,
    backgroundPosition: kind === 'dots' ? `${view.x - step / 2}px ${view.y - step / 2}px` : `${view.x}px ${view.y}px`,
  };
}

/** Room names (and a temperature when the room has a sensor), as HTML so text stays crisp at any zoom. */
export function RoomLabels({ view, rooms, devices, large }: { view: View; rooms: SurfaceRoom[]; devices: DeviceDTO[]; large?: boolean }) {
  return (
    <>
      {rooms.map((r) => {
        const [ax, ay] = labelAnchor(r.polygon);
        const temp = roomTemperature(r.room.id, devices);
        return (
          <div
            key={r.room.id}
            className="pointer-events-none absolute flex max-w-[160px] flex-col leading-tight select-none"
            style={{ left: ax * view.k + view.x, top: ay * view.k + view.y }}
          >
            <span className={large ? 'truncate text-[14px] font-bold text-muted' : 'truncate text-[12px] font-bold text-muted'}>{r.room.name}</span>
            {temp !== undefined && <span className={large ? 'text-[13px] font-semibold text-muted/80 tabular-nums' : 'text-[11px] font-semibold text-muted/80 tabular-nums'}>{round1(temp)}°</span>}
          </div>
        );
      })}
    </>
  );
}
