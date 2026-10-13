import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { DeviceDTO, Level, Placement, Room } from '@livynq/model';
import { api, errorMessage } from '../../lib/api.ts';
import { deviceKind, describe, sortDevices } from '../../lib/devices.ts';
import {
  ROOM_COLORS,
  bgOpacity as readBgOpacity,
  boundsOf,
  centroid,
  defaultMount,
  dist,
  formatArea,
  formatMeters,
  levelBounds,
  placedOn,
  pointInPolygon,
  polygonArea,
  rectPolygon,
  round2,
  roomColor,
  setBgOpacity,
  snap,
  type Pt,
} from '../../lib/floorplan.ts';
import { useLang, useT } from '../../lib/i18n.ts';
import { upsertLevel, upsertRoom, useLive } from '../../lib/live.ts';
import { confirmDialog } from '../dialog.tsx';
import { Icon, type IconName } from '../icons.tsx';
import { toast } from '../toast.tsx';
import { Button, ConfirmButton, IconButton, SectionLabel, Segmented, TextField, cx } from '../ui.tsx';
import { DeviceMarker, MARKER_SIZES } from './device-marker.tsx';
import { levelName, runAutoLayout } from './home-space.tsx';
import { PlanSvg, RoomLabels, gridStyle, surfaceRooms, useBackground } from './plan-surface.tsx';
import { MapButton } from './plan-view.tsx';
import { TAP_SLOP, usePanZoom } from './use-pan-zoom.ts';

type Tool = 'select' | 'rect' | 'poly' | 'scale';
type Selection = { kind: 'room'; id: string } | { kind: 'device'; id: string } | null;

type Drag =
  | { kind: 'rect'; pointer: number; a: Pt; b: Pt }
  | { kind: 'scale'; pointer: number; a: Pt; b: Pt }
  | { kind: 'vertex'; pointer: number; roomId: string; index: number; sx: number; sy: number; moved: boolean; orig: Pt[]; inserted: boolean }
  | { kind: 'room'; pointer: number; roomId: string; start: Pt; sx: number; sy: number; moved: boolean; orig: Pt[] }
  | { kind: 'device'; pointer: number; deviceId: string; sx: number; sy: number; moved: boolean; grab: Pt; orig: Placement };

interface UndoEntry {
  label: string;
  run: () => Promise<unknown>;
}

const SNAP_PX = 10;
const MAX_UNDO = 20;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];

/** Admin floor plan editor: levels, tracing image + scale, room outlines, device placement. */
export function PlanEditor({ levelId, onLevel, onDone }: { levelId: string; onLevel: (id: string) => void; onDone: () => void }) {
  const t = useT();
  const lang = useLang();
  const { levels: levelsOrNull, rooms, devices: byId } = useLive();
  const levels = levelsOrNull ?? [];
  const level = levels.find((l) => l.id === levelId);
  const devices = useMemo(() => Object.values(byId), [byId]);

  const ref = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [roomOverride, setRoomOverride] = useState<Record<string, Pt[]>>({});
  const [deviceOverride, setDeviceOverride] = useState<Record<string, Placement | null>>({});
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [poly, setPoly] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const [shape, setShape] = useState<Pt[] | null>(null);
  const [scaleLine, setScaleLine] = useState<[Pt, Pt] | null>(null);
  const [opacity, setOpacity] = useState(() => readBgOpacity(levelId));
  const [ghost, setGhost] = useState<{ deviceId: string; x: number; y: number; over: boolean } | null>(null);
  const undoStack = useRef<UndoEntry[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const hit = useRef(false);

  useEffect(() => setOpacity(readBgOpacity(levelId)), [levelId]);
  useEffect(() => {
    setSelection(null);
    setPoly([]);
    setShape(null);
    setScaleLine(null);
  }, [levelId]);

  // Overrides hold optimistic edits until the server echo matches.
  useEffect(() => {
    setDeviceOverride((o) => {
      const next = { ...o };
      let changed = false;
      for (const [id, p] of Object.entries(o)) {
        const cur = byId[id]?.placement ?? null;
        if ((p === null && cur === null) || (p && cur && cur.levelId === p.levelId && Math.abs(cur.x - p.x) < 1e-6 && Math.abs(cur.y - p.y) < 1e-6)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : o;
    });
  }, [byId]);
  useEffect(() => {
    setRoomOverride((o) => {
      const next = { ...o };
      let changed = false;
      for (const [id, p] of Object.entries(o)) {
        if (dragRef.current && 'roomId' in dragRef.current && dragRef.current.roomId === id) continue;
        const cur = rooms.find((r) => r.id === id)?.polygon;
        if (cur && JSON.stringify(cur) === JSON.stringify(p)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : o;
    });
  }, [rooms]);

  const viewDevices = useMemo(
    () => devices.map((d) => (d.id in deviceOverride ? { ...d, placement: deviceOverride[d.id] ?? null } : d)),
    [devices, deviceOverride],
  );
  const sRooms = useMemo(() => surfaceRooms(rooms, levelId, roomOverride), [rooms, levelId, roomOverride]);
  const bg = useBackground(level);
  const bounds = useMemo(() => levelBounds(level, rooms, devices, bg.aspect), [level, rooms, devices, bg.aspect]);
  const pz = usePanZoom(ref, bounds ?? { minX: 0, minY: 0, maxX: 12, maxY: 8 }, `${levelId}:${bg.aspect ?? 0}`, 48);
  const { view } = pz;
  const placed = placedOn(viewDevices, levelId);

  // ------------------------------------------------------------------ undo

  const pushUndo = (label: string, run: () => Promise<unknown>) => {
    undoStack.current = [...undoStack.current.slice(-(MAX_UNDO - 1)), { label, run }];
    setUndoCount(undoStack.current.length);
  };
  const undo = useCallback(async () => {
    const entry = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (!entry) return;
    try {
      await entry.run();
      toast(t('plan.undone', { what: entry.label }), 'info');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }, [t]);

  // ------------------------------------------------------------------ server writes

  const saveRoom = async (room: Room, patch: { polygon: Pt[] | null; levelId?: string | null; color?: string | null; name?: string }, label: string, created = false) => {
    const prev = { polygon: room.polygon, levelId: room.levelId, color: room.color };
    try {
      const updated = await api.updateRoom(room.id, { ...patch, levelId: patch.polygon ? levelId : (patch.levelId ?? null) });
      upsertRoom(updated);
      pushUndo(label, created ? () => api.deleteRoom(room.id) : () => api.updateRoom(room.id, prev).then(upsertRoom));
      return updated;
    } catch (e) {
      toast(errorMessage(e), 'error');
      setRoomOverride((o) => {
        const { [room.id]: _drop, ...rest } = o;
        return rest;
      });
      return undefined;
    }
  };

  const place = async (deviceId: string, at: Pt | null, extra?: Partial<Placement>) => {
    const d = byId[deviceId];
    if (!d) return;
    const prev = d.placement ?? null;
    const next: Placement | null = at
      ? { ...(prev && prev.levelId === levelId ? prev : {}), mount: prev?.mount ?? defaultMount(deviceKind(d)), ...extra, levelId, x: round2(at[0]), y: round2(at[1]) }
      : null;
    setDeviceOverride((o) => ({ ...o, [deviceId]: next }));
    try {
      await api.placeDevice(deviceId, next);
      pushUndo(d.name, () => api.placeDevice(deviceId, prev));
    } catch (e) {
      toast(errorMessage(e), 'error');
      setDeviceOverride((o) => {
        const { [deviceId]: _drop, ...rest } = o;
        return rest;
      });
    }
  };

  // ------------------------------------------------------------------ snapping

  const snapPoint = (p: Pt, skip?: { roomId: string; index?: number }, from?: Pt): Pt => {
    const tol = SNAP_PX / view.k;
    let best: Pt | null = null;
    let bestD = tol;
    for (const r of sRooms) {
      r.polygon.forEach((v, i) => {
        if (skip && r.room.id === skip.roomId && (skip.index === undefined || skip.index === i)) return;
        const d = dist(v, p);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      });
    }
    if (best) return best;
    let [x, y] = [round2(snap(p[0])), round2(snap(p[1]))];
    // Keep walls straight: align with the previous point when close to horizontal/vertical.
    if (from) {
      if (Math.abs(x - from[0]) < tol) x = from[0];
      if (Math.abs(y - from[1]) < tol) y = from[1];
    }
    return [x, y];
  };

  // ------------------------------------------------------------------ pointer handling

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (shape || scaleLine) return;
    const allowPan = tool === 'select' || tool === 'poly';
    pz.onPointerDown(e, allowPan);
    if (pz.pinching()) {
      setDrag(null);
      return;
    }
    if ((tool === 'rect' || tool === 'scale') && e.button === 0) {
      const p = snapPoint(pz.toWorld(e.clientX, e.clientY));
      setDrag(tool === 'rect' ? { kind: 'rect', pointer: e.pointerId, a: p, b: p } : { kind: 'scale', pointer: e.pointerId, a: p, b: p });
      ref.current?.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const w = pz.toWorld(e.clientX, e.clientY);
    if (tool === 'poly' && e.pointerType !== 'touch') setHover(snapPoint(w, undefined, poly[poly.length - 1]));
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (pz.pinching()) return setDrag(null);
    if (d.kind === 'rect' || d.kind === 'scale') {
      setDrag({ ...d, b: snapPoint(w, undefined, d.kind === 'scale' ? d.a : undefined) });
      return;
    }
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < TAP_SLOP) return;
      d.moved = true;
      try {
        ref.current?.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    if (d.kind === 'vertex') {
      const poly2 = d.orig.slice();
      poly2[d.index] = snapPoint(w, { roomId: d.roomId, index: d.index });
      setRoomOverride((o) => ({ ...o, [d.roomId]: poly2 }));
    } else if (d.kind === 'room') {
      const dx = snap(w[0] - d.start[0]);
      const dy = snap(w[1] - d.start[1]);
      setRoomOverride((o) => ({ ...o, [d.roomId]: d.orig.map(([x, y]) => [round2(x + dx), round2(y + dy)] as Pt) }));
    } else if (d.kind === 'device') {
      const at: Pt = [round2(snap(w[0] + d.grab[0], 0.05)), round2(snap(w[1] + d.grab[1], 0.05))];
      setDeviceOverride((o) => ({ ...o, [d.deviceId]: { ...d.orig, x: at[0], y: at[1] } }));
    }
    setDragState({ ...d });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId) return;
    setDrag(null);
    if (d.kind === 'rect') {
      const p = rectPolygon(d.a, d.b);
      const b = boundsOf(p);
      if (b.maxX - b.minX >= 0.5 && b.maxY - b.minY >= 0.5) setShape(p);
    } else if (d.kind === 'scale') {
      if (dist(d.a, d.b) >= 0.2) setScaleLine([d.a, d.b]);
    } else if (d.kind === 'vertex' || d.kind === 'room') {
      const room = rooms.find((r) => r.id === d.roomId);
      const next = roomOverride[d.roomId];
      if (room && d.moved && next) void saveRoom(room, { polygon: next }, room.name);
      else
        setRoomOverride((o) => {
          const { [d.roomId]: _drop, ...rest } = o;
          return rest;
        });
    } else if (d.kind === 'device' && d.moved) {
      const p = deviceOverride[d.deviceId];
      if (p) void place(d.deviceId, [p.x, p.y]);
    }
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const wasHit = hit.current;
    hit.current = false;
    if (tool === 'poly') {
      const p = snapPoint(pz.toWorld(e.clientX, e.clientY), undefined, poly[poly.length - 1]);
      const first = poly[0];
      const last = poly[poly.length - 1];
      const tol = (SNAP_PX * 1.5) / view.k;
      if (poly.length >= 3 && first && dist(p, first) < tol) return finishPoly();
      if (last && dist(p, last) < tol) return poly.length >= 3 ? finishPoly() : undefined;
      setPoly((ps) => [...ps, p]);
      return;
    }
    if (tool === 'select' && !wasHit) setSelection(null);
  };

  const finishPoly = () => {
    if (poly.length >= 3 && polygonArea(poly) >= 0.25) setShape(poly);
    setPoly([]);
    setHover(null);
  };

  const startRoomDrag = (roomId: string, e: ReactPointerEvent) => {
    if (tool !== 'select') return;
    hit.current = true;
    if (selection?.kind === 'room' && selection.id === roomId) {
      e.stopPropagation();
      const r = sRooms.find((x) => x.room.id === roomId);
      if (!r) return;
      setDrag({ kind: 'room', pointer: e.pointerId, roomId, start: pz.toWorld(e.clientX, e.clientY), sx: e.clientX, sy: e.clientY, moved: false, orig: r.polygon });
    } else {
      setSelection({ kind: 'room', id: roomId });
    }
  };

  const startVertexDrag = (roomId: string, index: number, e: ReactPointerEvent, insertAt?: Pt) => {
    e.stopPropagation();
    hit.current = true;
    const r = sRooms.find((x) => x.room.id === roomId);
    if (!r) return;
    let orig = r.polygon;
    if (insertAt) {
      orig = [...orig.slice(0, index), insertAt, ...orig.slice(index)];
      setRoomOverride((o) => ({ ...o, [roomId]: orig }));
    }
    setDrag({ kind: 'vertex', pointer: e.pointerId, roomId, index, sx: e.clientX, sy: e.clientY, moved: false, orig, inserted: !!insertAt });
  };

  const removeVertex = (roomId: string, index: number) => {
    const r = sRooms.find((x) => x.room.id === roomId);
    if (!r || r.polygon.length <= 3) return;
    const next = r.polygon.filter((_, i) => i !== index);
    setRoomOverride((o) => ({ ...o, [roomId]: next }));
    void saveRoom(r.room, { polygon: next }, r.room.name);
  };

  const startDeviceDrag = (d: DeviceDTO & { placement: Placement }, e: ReactPointerEvent) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    hit.current = true;
    const w = pz.toWorld(e.clientX, e.clientY);
    setDrag({ kind: 'device', pointer: e.pointerId, deviceId: d.id, sx: e.clientX, sy: e.clientY, moved: false, grab: [d.placement.x - w[0], d.placement.y - w[1]], orig: d.placement });
  };

  // Palette → plan: pointer-driven drag (works for touch, unlike HTML5 drag and drop).
  const startPaletteDrag = (deviceId: string, e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    const overCanvas = (x: number, y: number) => {
      const r = ref.current?.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      started = true;
      ev.preventDefault();
      setGhost({ deviceId, x: ev.clientX, y: ev.clientY, over: overCanvas(ev.clientX, ev.clientY) });
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setGhost(null);
      if (ev.type === 'pointercancel') return;
      if (!started) {
        // A tap places the device in the middle of the visible plan.
        void place(deviceId, pz.toWorld((ref.current?.getBoundingClientRect().left ?? 0) + pz.size.w / 2, (ref.current?.getBoundingClientRect().top ?? 0) + pz.size.h / 2));
        setSelection({ kind: 'device', id: deviceId });
        return;
      }
      if (overCanvas(ev.clientX, ev.clientY)) {
        const w = pz.toWorld(ev.clientX, ev.clientY);
        void place(deviceId, [snap(w[0], 0.05), snap(w[1], 0.05)]);
        setSelection({ kind: 'device', id: deviceId });
      }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  // ------------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void undo();
      } else if (e.key === 'Escape') {
        if (poly.length) setPoly([]);
        else if (shape) setShape(null);
        else setSelection(null);
      } else if (e.key === 'Enter' && poly.length >= 3) {
        finishPoly();
      } else if (e.key === 'Backspace' && poly.length) {
        setPoly((p) => p.slice(0, -1));
      } else if (e.key === 'v') setTool('select');
      else if (e.key === 'r') setTool('rect');
      else if (e.key === 'p') setTool('poly');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (tool !== 'poly') {
      setPoly([]);
      setHover(null);
    }
  }, [tool]);

  // ------------------------------------------------------------------ levels

  const addLevel = async () => {
    setBusy(true);
    try {
      const l = await api.createLevel(levelName(t, levels.length + 1, lang));
      upsertLevel(l);
      onLevel(l.id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!level) return null;

  const selRoom = selection?.kind === 'room' ? sRooms.find((r) => r.room.id === selection.id) : undefined;
  const selDevice = selection?.kind === 'device' ? viewDevices.find((d) => d.id === selection.id) : undefined;
  const box = MARKER_SIZES.md.box;
  const S = (p: Pt): Pt => [p[0] * view.k + view.x, p[1] * view.k + view.y];

  const draftRect = drag?.kind === 'rect' ? rectPolygon(drag.a, drag.b) : null;
  const polyPreview = tool === 'poly' && poly.length ? (hover ? [...poly, hover] : poly) : null;
  const scaleDraft = drag?.kind === 'scale' ? ([drag.a, drag.b] as [Pt, Pt]) : scaleLine;

  const hintKey =
    tool === 'rect' ? 'plan.hint.rect' : tool === 'poly' ? (poly.length ? 'plan.hint.polyMore' : 'plan.hint.poly') : tool === 'scale' ? 'plan.hint.scale' : selRoom ? 'plan.hint.room' : 'plan.hint.select';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="lv-scroll-x flex min-w-0 items-center gap-2 overflow-x-auto">
          <div role="tablist" aria-label={t('plan.levels')} className="flex gap-[3px] rounded-[13px] bg-chip p-1">
            {levels.map((l) => (
              <button
                key={l.id}
                type="button"
                role="tab"
                aria-selected={l.id === levelId}
                onClick={() => onLevel(l.id)}
                className={cx('min-h-8 rounded-[10px] border-0 px-3 py-1.5 text-[13px] font-bold whitespace-nowrap', l.id === levelId ? 'bg-surface text-ink shadow-card' : 'bg-transparent text-muted hover:text-ink')}
              >
                {l.name}
              </button>
            ))}
          </div>
          <Button size="sm" icon="plus" busy={busy} onClick={() => void addLevel()}>
            {t('plan.addLevel')}
          </Button>
        </div>
        <Button variant="primary" icon="check" onClick={onDone}>
          {t('plan.done')}
        </Button>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-panel border border-line bg-surface shadow-card">
          <div
            ref={ref}
            className={cx('lv-plan-bg relative h-[62dvh] min-h-[380px] touch-none overflow-hidden select-none lg:h-[calc(100dvh-210px)] lg:max-h-[860px]', tool !== 'select' && 'cursor-crosshair')}
            style={gridStyle(view, 'lines')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onClick={onClick}
            onDoubleClick={() => tool === 'poly' && poly.length >= 3 && finishPoly()}
          >
            <PlanSvg
              view={view}
              level={level}
              rooms={sRooms}
              devices={viewDevices}
              background={bg}
              bgOpacity={opacity}
              selectedRoomId={selRoom?.room.id}
              onRoomPointerDown={tool === 'select' ? (id, e) => startRoomDrag(id, e) : undefined}
            >
              {draftRect && <polygon points={draftRect.map((p) => p.join(',')).join(' ')} fill="color-mix(in oklab, var(--amber) 22%, transparent)" stroke="var(--amber-ink)" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />}
              {polyPreview && (
                <polyline points={polyPreview.map((p) => p.join(',')).join(' ')} fill={polyPreview.length > 2 ? 'color-mix(in oklab, var(--amber) 18%, transparent)' : 'none'} stroke="var(--amber-ink)" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              )}
              {shape && <polygon points={shape.map((p) => p.join(',')).join(' ')} fill="color-mix(in oklab, var(--amber) 28%, transparent)" stroke="var(--amber-ink)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
              {scaleDraft && <line x1={scaleDraft[0][0]} y1={scaleDraft[0][1]} x2={scaleDraft[1][0]} y2={scaleDraft[1][1]} stroke="var(--alert)" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
            </PlanSvg>
            <RoomLabels view={view} rooms={sRooms} devices={viewDevices} />

            {/* Selected room: edge lengths, vertex handles, midpoint handles to add a corner. */}
            {selRoom && tool === 'select' && (
              <>
                {selRoom.polygon.map((p, i) => {
                  const q = selRoom.polygon[(i + 1) % selRoom.polygon.length]!;
                  const [mx, my] = S([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
                  const len = dist(p, q);
                  return (
                    <div key={`e${i}`}>
                      {len * view.k > 70 && <DimChip x={mx} y={my - 16}>{formatMeters(len)}</DimChip>}
                      {len * view.k > 40 && (
                        <span
                          role="presentation"
                          title={t('plan.addCorner')}
                          onPointerDown={(e) => startVertexDrag(selRoom.room.id, i + 1, e, [round2((p[0] + q[0]) / 2), round2((p[1] + q[1]) / 2)])}
                          className="absolute size-3 -translate-1/2 cursor-copy rounded-full border-2 border-amber-ink bg-surface/80 opacity-70 hover:opacity-100"
                          style={{ left: mx, top: my }}
                        />
                      )}
                    </div>
                  );
                })}
                {selRoom.polygon.map((p, i) => {
                  const [sx, sy] = S(p);
                  return (
                    <span
                      key={`v${i}`}
                      role="presentation"
                      title={t('plan.vertexHint')}
                      onPointerDown={(e) => startVertexDrag(selRoom.room.id, i, e)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        removeVertex(selRoom.room.id, i);
                      }}
                      className="absolute size-4 -translate-1/2 cursor-move rounded-[5px] border-2 border-amber-ink bg-surface shadow-card"
                      style={{ left: sx, top: sy }}
                    />
                  );
                })}
              </>
            )}

            {/* Live dimensions while drawing. */}
            {draftRect && <DraftDims polygon={draftRect} S={S} rect />}
            {polyPreview && polyPreview.length >= 2 && (
              <>
                {(() => {
                  const a = polyPreview[polyPreview.length - 2]!;
                  const b = polyPreview[polyPreview.length - 1]!;
                  const [mx, my] = S([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
                  return <DimChip x={mx} y={my - 16}>{formatMeters(dist(a, b))}</DimChip>;
                })()}
                {polyPreview.length >= 3 && <DraftDims polygon={polyPreview} S={S} />}
              </>
            )}
            {poly.map((p, i) => {
              const [sx, sy] = S(p);
              return <span key={i} className={cx('pointer-events-none absolute -translate-1/2 rounded-full border-2 border-amber-ink', i === 0 ? 'size-3.5 bg-amber' : 'size-2.5 bg-surface')} style={{ left: sx, top: sy }} />;
            })}
            {scaleDraft && (() => {
              const [mx, my] = S([(scaleDraft[0][0] + scaleDraft[1][0]) / 2, (scaleDraft[0][1] + scaleDraft[1][1]) / 2]);
              return <DimChip x={mx} y={my - 16}>{formatMeters(dist(scaleDraft[0], scaleDraft[1]))}</DimChip>;
            })()}

            {placed.map((d) => (
              <div key={d.id} className="absolute" style={{ left: d.placement.x * view.k + view.x - box / 2, top: d.placement.y * view.k + view.y - box / 2, zIndex: 3, pointerEvents: tool === 'select' ? undefined : 'none' }}>
                <DeviceMarker
                  device={d}
                  interactive={false}
                  showValue={false}
                  selected={selDevice?.id === d.id}
                  dragging={drag?.kind === 'device' && drag.deviceId === d.id && drag.moved}
                  onPointerDown={(e) => startDeviceDrag(d, e)}
                  onOpen={() => {
                    hit.current = true;
                    setSelection({ kind: 'device', id: d.id });
                  }}
                />
              </div>
            ))}

            {/* Toolbar */}
            <div className="absolute top-3 left-3 flex flex-wrap items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <div role="radiogroup" aria-label={t('plan.tools')} className="flex gap-[3px] rounded-[13px] border border-line bg-surface p-1 shadow-card">
                <ToolButton icon="pointer" label={t('plan.tool.select')} on={tool === 'select'} onClick={() => setTool('select')} />
                <ToolButton icon="square" label={t('plan.tool.rect')} on={tool === 'rect'} onClick={() => setTool('rect')} />
                <ToolButton icon="pentagon" label={t('plan.tool.poly')} on={tool === 'poly'} onClick={() => setTool('poly')} />
                {level.background && <ToolButton icon="ruler" label={t('plan.tool.scale')} on={tool === 'scale'} onClick={() => setTool('scale')} />}
              </div>
              <MapButton icon="rotateCcw" label={t('plan.undo')} onClick={() => void undo()} className={undoCount ? undefined : 'pointer-events-none opacity-40'} />
            </div>
            <div className="absolute right-3 bottom-3 flex flex-col gap-1.5" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <MapButton icon="plus" label={t('plan.zoomIn')} onClick={() => pz.zoomBy(1.3)} />
              <MapButton icon="minus" label={t('plan.zoomOut')} onClick={() => pz.zoomBy(1 / 1.3)} />
              <MapButton icon="maximize" label={t('plan.fit')} onClick={() => pz.fit()} />
            </div>
            {!shape && !scaleLine && (
              <div className="pointer-events-none absolute inset-x-14 bottom-3 flex justify-center">
                <div className="flex max-w-full items-center gap-2 rounded-full bg-ink/85 px-3.5 py-2 text-[12.5px] font-semibold text-bg shadow-card backdrop-blur">
                  <Icon name="info" size={14} className="shrink-0" />
                  <span className="truncate">{t(hintKey)}</span>
                  {tool === 'poly' && poly.length >= 3 && (
                    <button type="button" className="pointer-events-auto rounded-full border-0 bg-amber px-2.5 py-0.5 text-[12px] font-bold text-on-amber" onClick={(e) => (e.stopPropagation(), finishPoly())}>
                      {t('plan.finish')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {shape && (
              <AssignShape
                polygon={shape}
                rooms={rooms}
                levelId={levelId}
                onCancel={() => setShape(null)}
                onSave={async (target, name, color) => {
                  let room = target ? rooms.find((r) => r.id === target) : undefined;
                  let created = false;
                  if (!room) {
                    room = await api.createRoom(name);
                    upsertRoom(room);
                    created = true;
                  }
                  const saved = await saveRoom(room, { polygon: shape, color, ...(created ? {} : {}) }, room.name, created);
                  if (saved) {
                    setShape(null);
                    setTool('select');
                    setSelection({ kind: 'room', id: saved.id });
                  }
                }}
              />
            )}
            {scaleLine && level.background && (
              <ScaleDialog
                measured={dist(scaleLine[0], scaleLine[1])}
                onCancel={() => setScaleLine(null)}
                onApply={async (real) => {
                  const bgInfo = level.background!;
                  const width = round2((bgInfo.widthMeters * real) / dist(scaleLine[0], scaleLine[1]));
                  const updated = await api.scaleLevelBackground(level.id, width);
                  upsertLevel(updated);
                  setScaleLine(null);
                  setTool('select');
                  toast(t('plan.scale.done', { w: formatMeters(width) }));
                }}
              />
            )}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-3 lg:max-h-[calc(100dvh-210px)] lg:w-[330px] lg:overflow-y-auto">
          {selRoom ? (
            <RoomPanel
              key={selRoom.room.id}
              room={selRoom.room}
              polygon={selRoom.polygon}
              index={selRoom.index}
              devices={viewDevices}
              onClose={() => setSelection(null)}
              onColor={(color) => void saveRoom(selRoom.room, { polygon: selRoom.polygon, color }, selRoom.room.name)}
              onDeleteOutline={() => {
                void saveRoom(selRoom.room, { polygon: null, levelId: null }, selRoom.room.name);
                setSelection(null);
              }}
            />
          ) : selDevice ? (
            <DevicePanel
              key={selDevice.id}
              device={selDevice}
              rooms={rooms}
              onClose={() => setSelection(null)}
              onMount={(mount) => selDevice.placement && void place(selDevice.id, [selDevice.placement.x, selDevice.placement.y], { mount, z: undefined })}
              onRemove={() => {
                void place(selDevice.id, null);
                setSelection(null);
              }}
            />
          ) : (
            <LevelPanel level={level} levels={levels} opacity={opacity} onOpacity={(v) => (setOpacity(v), setBgOpacity(level.id, v))} onScale={() => setTool('scale')} onDeleted={() => onLevel(levels.find((l) => l.id !== level.id)?.id ?? '')} />
          )}
          <DevicePalette devices={viewDevices} rooms={rooms} levelId={levelId} onDragStart={startPaletteDrag} onSelect={(id) => setSelection({ kind: 'device', id })} />
        </aside>
      </div>

      {ghost && (
        <div className="pointer-events-none fixed z-50" style={{ left: ghost.x - box / 2, top: ghost.y - box / 2, opacity: ghost.over ? 1 : 0.6 }}>
          {byId[ghost.deviceId] && <DeviceMarker device={byId[ghost.deviceId]!} interactive={false} showValue={false} dragging />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- small pieces

function ToolButton({ icon, label, on, onClick }: { icon: IconName; label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx('grid size-9 place-items-center rounded-[10px] border-0 transition-colors duration-base', on ? 'bg-ink text-bg' : 'bg-transparent text-muted hover:bg-chip hover:text-ink')}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

function DimChip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-bg tabular-nums shadow-card" style={{ left: x, top: y }}>
      {children}
    </span>
  );
}

function DraftDims({ polygon, S, rect }: { polygon: Pt[]; S: (p: Pt) => Pt; rect?: boolean }) {
  const b = boundsOf(polygon);
  const [cx_, cy_] = S(centroid(polygon));
  const area = polygonArea(polygon);
  return (
    <DimChip x={cx_} y={cy_}>
      {rect ? `${formatMeters(b.maxX - b.minX)} × ${formatMeters(b.maxY - b.minY)} · ` : ''}
      {formatArea(area)}
    </DimChip>
  );
}

function Floating({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="dialog"
      aria-label={label}
      className="absolute inset-x-3 bottom-3 z-10 mx-auto flex max-w-[380px] animate-sheet-up flex-col gap-3.5 rounded-[20px] border border-line bg-surface p-4 shadow-sheet"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function ColorSwatches({ value, onChange }: { value: string | null; onChange: (c: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('plan.roomColor')}>
      {ROOM_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cx('size-8 rounded-full border-2 transition-transform duration-base hover:scale-105', value === c ? 'border-ink' : 'border-surface shadow-card')}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

function AssignShape({ polygon, rooms, levelId, onCancel, onSave }: { polygon: Pt[]; rooms: Room[]; levelId: string; onCancel: () => void; onSave: (roomId: string | null, name: string, color: string) => Promise<void> }) {
  const t = useT();
  const NEW = '__new';
  const free = rooms.filter((r) => !r.polygon);
  const [target, setTarget] = useState<string>(free[0]?.id ?? NEW);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(() => {
    const idx = target === NEW ? rooms.length : rooms.findIndex((r) => r.id === target);
    const r = rooms.find((x) => x.id === target);
    return r?.color ?? ROOM_COLORS[Math.max(0, idx) % ROOM_COLORS.length]!;
  });
  const [saving, setSaving] = useState(false);
  const b = boundsOf(polygon);
  const chosen = rooms.find((r) => r.id === target);
  const replaces = chosen?.polygon ? (chosen.levelId === levelId ? 'here' : 'elsewhere') : null;
  const ok = target !== NEW || name.trim().length > 0;
  const save = async () => {
    if (!ok) return;
    setSaving(true);
    try {
      await onSave(target === NEW ? null : target, name.trim(), color);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Floating label={t('plan.assign.title')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[15px] font-extrabold">{t('plan.assign.title')}</div>
          <div className="text-xs text-muted tabular-nums">
            {formatMeters(b.maxX - b.minX)} × {formatMeters(b.maxY - b.minY)} · {formatArea(polygonArea(polygon))}
          </div>
        </div>
        <IconButton icon="x" label={t('common.cancel')} onClick={onCancel} className="size-8!" />
      </div>
      <div className="flex max-h-[148px] flex-wrap gap-1.5 overflow-y-auto">
        {rooms.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setTarget(r.id)}
            className={cx('flex min-h-8 items-center gap-1.5 rounded-full border-0 px-3 py-1 text-[12.5px] font-bold', target === r.id ? 'bg-ink text-bg' : 'bg-chip text-ink hover:bg-line')}
          >
            {r.polygon && <Icon name="check" size={12} className="opacity-60" />}
            {r.name}
          </button>
        ))}
        <button type="button" onClick={() => setTarget(NEW)} className={cx('flex min-h-8 items-center gap-1 rounded-full border-0 px-3 py-1 text-[12.5px] font-bold', target === NEW ? 'bg-ink text-bg' : 'bg-amber-soft text-ink')}>
          <Icon name="plus" size={13} />
          {t('plan.assign.new')}
        </button>
      </div>
      {target === NEW && <TextField label={t('plan.assign.name')} value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} placeholder={t('plan.assign.placeholder')} />}
      {replaces && <div className="text-xs text-amber-ink">{t(replaces === 'here' ? 'plan.assign.replace' : 'plan.assign.move')}</div>}
      <ColorSwatches value={color} onChange={setColor} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="amber" icon="check" busy={saving} disabled={!ok} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </div>
    </Floating>
  );
}

function ScaleDialog({ measured, onCancel, onApply }: { measured: number; onCancel: () => void; onApply: (real: number) => Promise<void> }) {
  const t = useT();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const real = Number(value.replace(',', '.'));
  const ok = real > 0 && real < 1000;
  const apply = async () => {
    if (!ok) return;
    setSaving(true);
    try {
      await onApply(real);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Floating label={t('plan.scale.title')}>
      <div>
        <div className="text-[15px] font-extrabold">{t('plan.scale.title')}</div>
        <div className="text-xs text-muted">{t('plan.scale.body', { m: formatMeters(measured) })}</div>
      </div>
      <TextField label={t('plan.scale.real')} inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void apply()} placeholder="4.2" />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="amber" icon="ruler" busy={saving} disabled={!ok} onClick={() => void apply()}>
          {t('plan.scale.apply')}
        </Button>
      </div>
    </Floating>
  );
}

function Panel({ title, children, onClose, icon }: { title: ReactNode; children: ReactNode; onClose?: () => void; icon?: IconName }) {
  const t = useT();
  return (
    <section className="flex flex-col gap-3.5 rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2">
        {icon && <Icon name={icon} size={16} className="text-muted" />}
        <div className="min-w-0 flex-1 truncate text-[15px] font-extrabold">{title}</div>
        {onClose && <IconButton icon="x" label={t('common.close')} onClick={onClose} className="size-8!" />}
      </div>
      {children}
    </section>
  );
}

function CommitField({ label, value, onCommit, type = 'text', suffix }: { label: string; value: string; onCommit: (v: string) => void; type?: string; suffix?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && draft.trim() && onCommit(draft.trim());
  return (
    <TextField
      label={label}
      type={type}
      step={type === 'number' ? 0.1 : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      hint={suffix}
    />
  );
}

function LevelPanel({ level, levels, opacity, onOpacity, onScale, onDeleted }: { level: Level; levels: Level[]; opacity: number; onOpacity: (v: number) => void; onScale: () => void; onDeleted: () => void }) {
  const t = useT();
  const lang = useLang();
  const file = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(String(level.background?.widthMeters ?? 12));
  const [progress, setProgress] = useState<number | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const { rooms } = useLive();
  const patch = (p: { name?: string; elevation?: number }) =>
    api.updateLevel(level.id, p).then(upsertLevel, (e: unknown) => toast(errorMessage(e), 'error'));

  const upload = async (f: File) => {
    if (!OK_TYPES.includes(f.type)) return toast(t('plan.bg.badType'), 'error');
    if (f.size > 10 * 1024 * 1024) return toast(t('wall.tooBig'), 'error');
    const w = Number(width.replace(',', '.'));
    setProgress(0);
    try {
      upsertLevel(await api.uploadLevelBackground(level.id, f, w > 0 && w < 1000 ? w : 12, setProgress));
      toast(t('plan.bg.uploaded'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setProgress(null);
    }
  };

  return (
    <Panel title={t('plan.levelPanel')} icon="layers">
      <div className="grid grid-cols-[1fr_110px] gap-2.5">
        <CommitField label={t('plan.levelName')} value={level.name} onCommit={(name) => void patch({ name })} />
        <CommitField label={t('plan.elevation')} type="number" value={String(level.elevation)} onCommit={(v) => Number.isFinite(Number(v)) && void patch({ elevation: Number(v) })} />
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>{t('plan.bg.title')}</SectionLabel>
        {level.background ? (
          <>
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span className="text-muted">{t('plan.bg.width', { w: formatMeters(level.background.widthMeters) })}</span>
              <Button size="sm" icon="ruler" onClick={onScale}>
                {t('plan.tool.scale')}
              </Button>
            </div>
            <label className="flex items-center gap-3 text-[13px] font-bold">
              <span className="shrink-0">{t('plan.bg.opacity')}</span>
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => onOpacity(Number(e.target.value))} className="lv-range" style={{ ['--fill' as string]: `${((opacity - 0.1) / 0.9) * 100}%` }} />
            </label>
            <div className="flex gap-2">
              <Button size="sm" icon="upload" onClick={() => file.current?.click()} busy={progress !== null}>
                {t('wall.replace')}
              </Button>
              <ConfirmButton size="sm" label={t('wall.remove')} confirmLabel={t('wall.removeConfirm')} onConfirm={() => void api.deleteLevelBackground(level.id).then(upsertLevel, (e: unknown) => toast(errorMessage(e), 'error'))} />
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-xs leading-relaxed text-muted">{t('plan.bg.body')}</p>
            <div className="flex items-end gap-2">
              <div className="w-[120px]">
                <TextField label={t('plan.bg.widthLabel')} inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} />
              </div>
              <Button icon="upload" busy={progress !== null} onClick={() => file.current?.click()} className="min-h-11">
                {progress !== null ? `${Math.round(progress * 100)}%` : t('plan.bg.upload')}
              </Button>
            </div>
          </>
        )}
        <input
          ref={file}
          type="file"
          accept={OK_TYPES.join(',')}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>

      {rooms.some((r) => !r.polygon) && (
        <Button
          icon="wand"
          busy={autoBusy}
          onClick={() => {
            setAutoBusy(true);
            runAutoLayout(t, lang, level.id)
              .catch((e: unknown) => toast(errorMessage(e), 'error'))
              .finally(() => setAutoBusy(false));
          }}
        >
          {t('plan.auto.ctaRest')}
        </Button>
      )}

      <div className="flex justify-end">
        <ConfirmButton
          size="sm"
          label={t('plan.deleteLevel')}
          confirmLabel={t('plan.deleteLevelConfirm')}
          onConfirm={async () => {
            const ok = levels.length > 1 || (await confirmDialog({ title: t('plan.deleteLast.title'), body: t('plan.deleteLast.body'), confirmLabel: t('common.delete'), danger: true, icon: 'trash' }));
            if (!ok) return;
            try {
              await api.deleteLevel(level.id);
              onDeleted();
            } catch (e) {
              toast(errorMessage(e), 'error');
            }
          }}
        />
      </div>
    </Panel>
  );
}

function RoomPanel({ room, polygon, index, devices, onClose, onColor, onDeleteOutline }: { room: Room; polygon: Pt[]; index: number; devices: DeviceDTO[]; onClose: () => void; onColor: (c: string) => void; onDeleteOutline: () => void }) {
  const t = useT();
  const b = boundsOf(polygon);
  const inside = devices.filter((d) => d.placement && pointInPolygon(d.placement.x, d.placement.y, polygon)).length;
  return (
    <Panel title={room.name} onClose={onClose} icon="square">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label={t('plan.area')} value={formatArea(polygonArea(polygon))} />
        <Stat label={t('plan.size')} value={`${round2(b.maxX - b.minX)}×${round2(b.maxY - b.minY)}`} />
        <Stat label={t('plan.devicesIn')} value={String(inside)} />
      </div>
      <CommitField label={t('plan.roomName')} value={room.name} onCommit={(name) => void api.updateRoom(room.id, { name }).then(upsertRoom, (e: unknown) => toast(errorMessage(e), 'error'))} />
      <div className="flex flex-col gap-2">
        <SectionLabel>{t('plan.roomColor')}</SectionLabel>
        <ColorSwatches value={room.color ?? roomColor(room, index)} onChange={onColor} />
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted">{t('plan.roomEditHint')}</p>
      <div className="flex justify-end">
        <ConfirmButton size="sm" icon="trash" label={t('plan.deleteOutline')} confirmLabel={t('plan.deleteOutlineConfirm')} onConfirm={onDeleteOutline} />
      </div>
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-tile bg-chip px-2 py-2">
      <div className="text-[15px] font-extrabold tabular-nums">{value}</div>
      <div className="text-[11px] font-semibold text-muted">{label}</div>
    </div>
  );
}

const MOUNTS = ['ceiling', 'wall', 'furniture', 'floor'] as const;

function DevicePanel({ device, rooms, onClose, onMount, onRemove }: { device: DeviceDTO; rooms: Room[]; onClose: () => void; onMount: (m: (typeof MOUNTS)[number]) => void; onRemove: () => void }) {
  const t = useT();
  const v = describe(device, t);
  const room = rooms.find((r) => r.id === device.roomId)?.name;
  const mount = device.placement?.mount ?? defaultMount(deviceKind(device));
  return (
    <Panel title={device.name} onClose={onClose} icon={v.icon}>
      <div className="text-[13px] text-muted">
        {room ?? t('home.other')} · {v.stateText}
      </div>
      {device.placement ? (
        <>
          <div className="flex flex-col gap-2">
            <SectionLabel>{t('plan.mount')}</SectionLabel>
            <Segmented size="sm" label={t('plan.mount')} value={mount} onChange={onMount} options={MOUNTS.map((m) => ({ value: m, label: t(`plan.mount.${m}`) }))} />
          </div>
          <p className="m-0 text-xs text-muted">{t('plan.deviceHint')}</p>
          <div className="flex justify-end">
            <Button size="sm" icon="mapPinOff" onClick={onRemove}>
              {t('plan.unplace')}
            </Button>
          </div>
        </>
      ) : (
        <p className="m-0 text-xs text-muted">{t('plan.dragHint')}</p>
      )}
    </Panel>
  );
}

function DevicePalette({ devices, rooms, levelId, onDragStart, onSelect }: { devices: DeviceDTO[]; rooms: Room[]; levelId: string; onDragStart: (id: string, e: ReactPointerEvent) => void; onSelect: (id: string) => void }) {
  const t = useT();
  const unplaced = sortDevices(devices.filter((d) => !d.placement));
  const here = devices.filter((d) => d.placement?.levelId === levelId).length;
  const groups = [...rooms.map((r) => ({ id: r.id, name: r.name, list: unplaced.filter((d) => d.roomId === r.id) })), { id: '_', name: t('home.other'), list: unplaced.filter((d) => !d.roomId || !rooms.some((r) => r.id === d.roomId)) }].filter((g) => g.list.length);
  return (
    <Panel title={t('plan.palette', { n: unplaced.length })} icon="grip">
      <div className="-mt-2 text-xs text-muted">{unplaced.length ? t('plan.paletteHint') : t('plan.allPlaced', { n: here })}</div>
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-1.5">
          <SectionLabel className="text-[11px]">{g.name}</SectionLabel>
          {g.list.map((d) => {
            const v = describe(d, t);
            return (
              <div
                key={d.id}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => onDragStart(d.id, e)}
                onKeyDown={(e) => e.key === 'Enter' && onSelect(d.id)}
                className="flex min-h-11 cursor-grab touch-pan-y items-center gap-2.5 rounded-tile border border-line bg-surface2 px-2.5 py-1.5 select-none hover:border-wall/50 active:cursor-grabbing"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-chip text-muted">
                  <Icon name={v.icon} size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{d.name}</span>
                <Icon name="grip" size={15} className="shrink-0 text-muted" />
              </div>
            );
          })}
        </div>
      ))}
      {!groups.length && (
        <div className="flex items-center gap-2 rounded-tile bg-ok-soft px-3 py-2.5 text-[13px] font-semibold">
          <Icon name="circleCheck" size={16} className="text-ok" />
          {t('plan.allPlacedShort')}
        </div>
      )}
    </Panel>
  );
}

