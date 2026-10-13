import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { describe, formatTemp, readings, round1, type DeviceView } from '../../lib/devices.ts';
import { useT, type Translate } from '../../lib/i18n.ts';
import { useAnyPending, useCommand } from '../device-controls.tsx';
import { Icon } from '../icons.tsx';
import { Spinner, cx } from '../ui.tsx';

export type MarkerSize = 'sm' | 'md' | 'lg';
export const MARKER_SIZES: Record<MarkerSize, { box: number; icon: number }> = { sm: { box: 32, icon: 14 }, md: { box: 38, icon: 16 }, lg: { box: 46, icon: 19 } };

const LONG_PRESS_MS = 480;

/** Marker look per state, following the prototype: amber when on, alert red, quiet surface when idle. */
export function markerStyle(v: DeviceView): { bg: string; fg: string; halo?: string } {
  if (v.tone === 'offline') return { bg: 'var(--surface)', fg: 'var(--muted)' };
  if (v.tone === 'alert') return { bg: 'var(--alert)', fg: '#fff', halo: 'var(--alert)' };
  if (v.tone === 'active') {
    const c = v.glow ?? 'var(--amber)';
    return { bg: c, fg: 'var(--on-amber)', halo: c };
  }
  return { bg: 'var(--surface)', fg: 'var(--muted)' };
}

/** Short value shown under a marker (temperatures, cover position). */
export function markerValue(d: DeviceDTO, v: DeviceView): string | undefined {
  if (v.tone === 'offline') return undefined;
  if (v.kind === 'climate' && v.climate) return v.climate.mode && v.climate.mode !== 'off' && v.climate.target !== undefined ? `${formatTemp(v.climate.current)} → ${formatTemp(v.climate.target)}` : formatTemp(v.climate.current);
  if (v.kind === 'cover' && v.cover?.position !== undefined) return `${v.cover.position}%`;
  if (v.kind === 'sensor') {
    const temp = readings(d).find((r) => r.capability === 'temperatureMeasurement');
    if (temp) return `${round1(temp.value)}°`;
  }
  return undefined;
}

export function markerLabel(d: DeviceDTO, v: DeviceView, t: Translate): string {
  return `${d.name} · ${v.stateText}${v.toggleEndpoint !== undefined ? ` · ${t('plan.longPress')}` : ''}`;
}

/**
 * Round device marker used by the 2D plan and as the 3D overlay: reflects live state, tap opens the
 * control sheet, long-press toggles lights/plugs/switches (like the icon button on cards).
 */
export function DeviceMarker({
  device,
  size = 'md',
  onOpen,
  selected,
  dragging,
  showValue = true,
  onPointerDown,
  interactive = true,
}: {
  device: DeviceDTO;
  size?: MarkerSize;
  onOpen?: () => void;
  selected?: boolean;
  dragging?: boolean;
  showValue?: boolean;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  /** False in the editor: no long-press toggling. */
  interactive?: boolean;
}) {
  const t = useT();
  const run = useCommand();
  const v = describe(device, t);
  const s = markerStyle(v);
  const { box, icon } = MARKER_SIZES[size];
  const pending = useAnyPending(device);
  const value = showValue ? markerValue(device, v) : undefined;
  const offline = v.tone === 'offline';
  const motion = v.kind === 'motion' && v.tone === 'active';
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  useEffect(() => () => clearTimeout(press.current?.timer), []);

  const canToggle = interactive && !offline && v.toggleEndpoint !== undefined;
  const startPress = (e: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(e);
    if (!canToggle) return;
    clearTimeout(press.current?.timer);
    const p = {
      x: e.clientX,
      y: e.clientY,
      fired: false,
      timer: setTimeout(() => {
        p.fired = true;
        navigator.vibrate?.(12);
        void run(device.id, v.toggleEndpoint!, 'onOff', v.on ? 'off' : 'on');
      }, LONG_PRESS_MS),
    };
    press.current = p;
  };
  const cancelPress = () => clearTimeout(press.current?.timer);

  const ring: CSSProperties = {};
  if (v.kind === 'cover' && v.cover?.position !== undefined && !offline) {
    // Cover position as a ring around the marker.
    ring.background = `conic-gradient(var(--amber) ${v.cover.position * 3.6}deg, color-mix(in oklab, var(--wall) 35%, transparent) 0)`;
  }

  const lockDot = v.kind === 'lock' && !offline ? (v.lock === 'locked' ? 'var(--ok)' : v.lock === 'jammed' ? 'var(--alert)' : v.lock === 'unlocked' ? 'var(--amber-ink)' : undefined) : undefined;

  return (
    <div className="pointer-events-none relative flex flex-col items-center" style={{ width: box }}>
      {motion && <span className="lv-ping pointer-events-none absolute rounded-full" style={{ width: box, height: box, background: s.halo }} aria-hidden="true" />}
      <button
        type="button"
        aria-label={markerLabel(device, v, t)}
        title={markerLabel(device, v, t)}
        onPointerDown={startPress}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => canToggle && e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          if (press.current?.fired) {
            press.current = null;
            return;
          }
          onOpen?.();
        }}
        className={cx(
          'pointer-events-auto relative grid touch-none place-items-center rounded-full border-0 p-0 transition-[transform,box-shadow] duration-base select-none [-webkit-touch-callout:none] active:scale-95',
          dragging && 'scale-110 cursor-grabbing',
          offline && 'opacity-60',
        )}
        style={{
          width: box,
          height: box,
          padding: ring.background ? 3 : 0,
          ...ring,
          boxShadow: selected
            ? '0 0 0 3px var(--surface), 0 0 0 5px var(--ink)'
            : s.halo
              ? `0 0 0 5px color-mix(in oklab, ${s.halo} 28%, transparent), 0 4px 14px -2px color-mix(in oklab, ${s.halo} 60%, transparent)`
              : '0 2px 6px oklch(0.3 0.03 60 / 0.22)',
        }}
      >
        <span
          className="grid size-full place-items-center rounded-full transition-[background-color,color] duration-slow"
          style={{ background: s.bg, color: s.fg, border: ring.background ? undefined : '2px solid var(--surface)' }}
        >
          <Icon name={offline ? 'wifiOff' : v.icon} size={icon} className={v.kind === 'fan' && v.on ? 'lv-spin-slow' : undefined} />
        </span>
        {lockDot && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface" style={{ background: lockDot }} aria-hidden="true" />}
        {pending && (
          <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-surface text-muted shadow-card" aria-hidden="true">
            <Spinner size={10} />
          </span>
        )}
      </button>
      {value && (
        <span className="mt-1 rounded-full bg-surface/90 px-1.5 py-px text-[10.5px] leading-tight font-bold whitespace-nowrap text-ink tabular-nums shadow-card" style={{ fontSize: size === 'lg' ? 12 : undefined }}>
          {value}
        </span>
      )}
    </div>
  );
}
