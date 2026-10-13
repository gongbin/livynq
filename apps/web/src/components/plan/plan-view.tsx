import { useMemo, useRef } from 'react';
import type { DeviceDTO, Level, Room } from '@livynq/model';
import { describe } from '../../lib/devices.ts';
import { levelBounds, placedOn } from '../../lib/floorplan.ts';
import { useT } from '../../lib/i18n.ts';
import { IconButton, cx } from '../ui.tsx';
import { DeviceMarker, MARKER_SIZES, type MarkerSize } from './device-marker.tsx';
import { PlanSvg, RoomLabels, gridStyle, surfaceRooms, useBackground } from './plan-surface.tsx';
import { usePanZoom } from './use-pan-zoom.ts';

/** Floating round controls in a plan corner (zoom, fit, reset). */
export function MapButton({ icon, label, onClick, className }: { icon: Parameters<typeof IconButton>[0]['icon']; label: string; onClick: () => void; className?: string }) {
  return <IconButton icon={icon} label={label} onClick={onClick} className={cx('size-9! rounded-[11px]! border border-line bg-surface! shadow-card hover:bg-chip!', className)} />;
}

/** Read-only 2D plan of one level: live device markers, tap to control, long-press to toggle. */
export function PlanView({ level, rooms, devices, onOpen, markerSize = 'md', large }: { level: Level; rooms: Room[]; devices: DeviceDTO[]; onOpen: (id: string) => void; markerSize?: MarkerSize; large?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const bg = useBackground(level);
  const sRooms = useMemo(() => surfaceRooms(rooms, level.id), [rooms, level.id]);
  // The tracing image is an editing aid; it doubles as the plan only while no rooms are drawn.
  const showBg = sRooms.length === 0;
  const bounds = useMemo(() => levelBounds(level, rooms, devices, showBg ? bg.aspect : undefined), [level, rooms, devices, showBg, bg.aspect]);
  const pz = usePanZoom(ref, bounds, `${level.id}:${showBg ? (bg.aspect ?? 0) : 'r'}`, large ? 56 : 36);
  const { view } = pz;
  const placed = useMemo(() => placedOn(devices, level.id).sort((a, b) => a.placement.y - b.placement.y), [devices, level.id]);
  const box = MARKER_SIZES[markerSize].box;

  return (
    <div ref={ref} className="lv-plan-bg absolute inset-0 touch-none overflow-hidden select-none" style={gridStyle(view, 'dots')} onPointerDown={(e) => pz.onPointerDown(e)}>
      <PlanSvg view={view} level={level} rooms={sRooms} devices={devices} background={showBg ? bg : null} bgOpacity={0.6} />
      <RoomLabels view={view} rooms={sRooms} devices={devices} large={large} />
      {placed.map((d) => (
        <div key={d.id} className="absolute" style={{ left: d.placement.x * view.k + view.x - box / 2, top: d.placement.y * view.k + view.y - box / 2, zIndex: describe(d, t).tone === 'idle' ? 1 : 2 }}>
          <DeviceMarker device={d} size={markerSize} onOpen={() => onOpen(d.id)} />
        </div>
      ))}
      <div className="absolute right-3 bottom-3 flex flex-col gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
        <MapButton icon="plus" label={t('plan.zoomIn')} onClick={() => pz.zoomBy(1.3)} />
        <MapButton icon="minus" label={t('plan.zoomOut')} onClick={() => pz.zoomBy(1 / 1.3)} />
        <MapButton icon="maximize" label={t('plan.fit')} onClick={() => pz.fit()} />
      </div>
    </div>
  );
}

/** Legend under the plan, as in the prototype. */
export function PlanLegend({ note }: { note?: string }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3.5 gap-y-1.5 px-1.5 pt-3 text-[12.5px] text-muted">
      <div className="flex flex-wrap gap-3.5">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-amber" />
          {t('plan.legend.on')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border-[1.5px] border-wall bg-surface" />
          {t('plan.legend.idle')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-alert" />
          {t('plan.legend.alert')}
        </span>
      </div>
      {note && <span>{note}</span>}
    </div>
  );
}
