import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Bounds, Pt } from '../../lib/floorplan.ts';

/** screen = world * k + (x, y); world in meters, screen in CSS px relative to the container. */
export interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 4;
const MAX_K = 420;
/** Movement (px) before a press turns into a pan; below it a tap stays a tap. */
export const TAP_SLOP = 6;

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export interface PanZoom {
  view: View;
  size: { w: number; h: number };
  toWorld: (clientX: number, clientY: number) => Pt;
  toScreen: (p: Pt) => Pt;
  fit: (animate?: boolean) => void;
  zoomBy: (factor: number) => void;
  /** Call from the container's onPointerDown; pass allowPan=false when a tool owns single-finger drags. */
  onPointerDown: (e: ReactPointerEvent, allowPan?: boolean) => void;
  /** True while two fingers are down (tools should ignore their own drags then). */
  pinching: () => boolean;
}

/**
 * Pan (drag), pinch (two fingers) and wheel zoom for an SVG/HTML plan. A drag that moved more than
 * TAP_SLOP swallows the following click, so markers stay tappable inside a pannable area.
 */
export function usePanZoom(ref: RefObject<HTMLElement | null>, bounds: Bounds | null, fitKey: string, padding = 36): PanZoom {
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 40 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const touched = useRef(false);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: 'pan'; id: number; sx: number; sy: number; v0: View; moved: boolean }
    | { kind: 'pinch'; d0: number; mid0: Pt; v0: View }
    | null
  >(null);
  const suppressClick = useRef(false);

  const fitView = useCallback(
    (b: Bounds | null, s: { w: number; h: number }): View | null => {
      if (!s.w || !s.h) return null;
      const bb = b ?? { minX: 0, minY: 0, maxX: 10, maxY: 7 };
      const bw = Math.max(1, bb.maxX - bb.minX);
      const bh = Math.max(1, bb.maxY - bb.minY);
      const pad = Math.min(padding, s.w / 8, s.h / 8);
      const k = clampK(Math.min((s.w - pad * 2) / bw, (s.h - pad * 2) / bh));
      return { k, x: s.w / 2 - ((bb.minX + bb.maxX) / 2) * k, y: s.h / 2 - ((bb.minY + bb.maxY) / 2) * k };
    },
    [padding],
  );

  const fit = useCallback(() => {
    touched.current = false;
    const v = fitView(boundsRef.current, sizeRef.current);
    if (v) setView(v);
  }, [fitView]);

  // Track the container size; keep the plan fitted until the user pans or zooms.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  useLayoutEffect(() => {
    if (touched.current) return;
    const v = fitView(bounds, size);
    if (v) setView(v);
    // Refit on a new level / first data / resize, not on every bounds tweak while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w, size.h, bounds === null]);

  useEffect(() => {
    touched.current = false;
  }, [fitKey]);

  const rect = () => ref.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const toWorld = useCallback(
    (cx: number, cy: number): Pt => {
      const r = rect();
      const v = viewRef.current;
      return [(cx - r.left - v.x) / v.k, (cy - r.top - v.y) / v.k];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const toScreen = useCallback((p: Pt): Pt => {
    const v = viewRef.current;
    return [p[0] * v.k + v.x, p[1] * v.k + v.y];
  }, []);

  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    touched.current = true;
    setView((v) => {
      const k = clampK(v.k * factor);
      const wx = (sx - v.x) / v.k;
      const wy = (sy - v.y) / v.k;
      return { k, x: sx - wx * k, y: sy - wy * k };
    });
  }, []);

  const zoomBy = useCallback((factor: number) => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, factor), [zoomAt]);

  // Wheel zoom needs a non-passive listener; clicks after a drag are swallowed in the capture phase.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    const onClick = (e: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('click', onClick, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('click', onClick, true);
    };
  }, [ref, zoomAt]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, local(e));
      const g = gesture.current;
      if (!g) return;
      if (g.kind === 'pinch') {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const mid: Pt = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        const k = clampK(g.v0.k * (d / g.d0));
        const wx = (g.mid0[0] - g.v0.x) / g.v0.k;
        const wy = (g.mid0[1] - g.v0.y) / g.v0.k;
        setView({ k, x: mid[0] - wx * k, y: mid[1] - wy * k });
        return;
      }
      if (e.pointerId !== g.id) return;
      const p = pointers.current.get(e.pointerId)!;
      const dx = p.x - g.sx;
      const dy = p.y - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      if (!g.moved) {
        g.moved = true;
        touched.current = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // pointer already gone
        }
      }
      setView({ ...g.v0, x: g.v0.x + dx, y: g.v0.y + dy });
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.delete(e.pointerId);
      const g = gesture.current;
      if (g?.kind === 'pan' && g.id === e.pointerId) {
        if (g.moved) suppressClick.current = true;
        gesture.current = null;
      } else if (g?.kind === 'pinch') {
        // Lifting one finger of a pinch must not turn into a tap.
        suppressClick.current = true;
        gesture.current = null;
      }
      // Clear a stale suppression if no click follows (e.g. the press ended outside).
      setTimeout(() => (suppressClick.current = false), 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [ref]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent, allowPan = true) => {
      const el = ref.current;
      if (!el || (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1)) return;
      const r = el.getBoundingClientRect();
      pointers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
        touched.current = true;
        gesture.current = { kind: 'pinch', d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)), mid0: [(a.x + b.x) / 2, (a.y + b.y) / 2], v0: viewRef.current };
        return;
      }
      if (allowPan || e.button === 1) {
        const p = pointers.current.get(e.pointerId)!;
        gesture.current = { kind: 'pan', id: e.pointerId, sx: p.x, sy: p.y, v0: viewRef.current, moved: false };
      }
    },
    [ref],
  );

  const pinching = useCallback(() => gesture.current?.kind === 'pinch', []);

  return { view, size, toWorld, toScreen, fit, zoomBy, onPointerDown, pinching };
}
