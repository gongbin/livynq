import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { degreesToHue, kelvinToMireds, percentToLevel, percentToSat } from '@livynq/model';
import { errorMessage } from '../lib/api.ts';
import { AwaitingApproval } from '../lib/confirmations.ts';
import { useT } from '../lib/i18n.ts';
import { pendingKey, sendCommand, useLive } from '../lib/live.ts';
import { kelvinColor, type LightState } from '../lib/devices.ts';
import { toast } from './toast.tsx';
import { cx } from './ui.tsx';

/**
 * Runs a device command; failures surface as a toast. Resolves to whether it took effect.
 * A command held for human approval is not a failure: it gets a calm notice, and the
 * approval banner takes over from there.
 */
export function useCommand() {
  const t = useT();
  return (deviceId: string, endpointId: number, capability: string, command: string, params?: Record<string, unknown>) =>
    sendCommand(deviceId, endpointId, { capability, command, params }).then(
      () => true,
      (err: unknown) => {
        if (err instanceof AwaitingApproval) toast(t('dev.awaitingApproval'), 'info');
        else toast(t('dev.commandFailed', { msg: errorMessage(err) }), 'error');
        return false;
      },
    );
}

export function usePending(deviceId: string, endpointId: number | undefined, capability: string): boolean {
  const { pending } = useLive();
  return endpointId !== undefined && pending.has(pendingKey(deviceId, endpointId, capability));
}

export function useAnyPending(d: DeviceDTO): boolean {
  const { pending } = useLive();
  const prefix = `${d.id}#`;
  for (const k of pending) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * A range input that sends commands while dragging (debounced) but never pretends:
 * the thumb follows the finger, and once released it shows the device-reported
 * value again as soon as the device has answered.
 */
export function CommandSlider({
  label,
  value,
  min,
  max,
  step = 1,
  pending,
  disabled,
  onSend,
  format,
  track,
  compact,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  pending: boolean;
  disabled?: boolean;
  onSend: (v: number) => void;
  format?: (v: number) => string;
  /** Custom track background (e.g. gradient); default fills with amber up to the value. */
  track?: string;
  compact?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const [released, setReleased] = useState(0);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (draft !== null && !pending && !dragging.current && timer.current === undefined) setDraft(null);
  }, [pending, draft, released]);

  const shown = draft ?? value ?? min;
  const fill = `${((shown - min) / (max - min)) * 100}%`;

  const schedule = (v: number) => {
    setDraft(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      onSend(v);
      setReleased((n) => n + 1);
    }, 150);
  };
  const release = () => {
    dragging.current = false;
    setReleased((n) => n + 1);
  };

  return (
    <div className={cx('flex flex-col', compact ? 'gap-0.5' : 'gap-1.5')}>
      {!compact && (
        <div className="flex justify-between text-[13px] font-bold">
          <label htmlFor={id}>{label}</label>
          <span className={cx('font-mono transition-opacity duration-base', pending && 'opacity-60')}>{format ? format(shown) : shown}</span>
        </div>
      )}
      <input
        id={id}
        type="range"
        className="lv-range"
        aria-label={compact ? label : undefined}
        aria-valuetext={format ? format(shown) : undefined}
        aria-busy={pending || undefined}
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled || value === undefined}
        style={{ '--fill': fill, ...(track ? { '--track': track } : {}) } as CSSProperties}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={release}
        onPointerCancel={release}
        onBlur={release}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => schedule(Number(e.target.value))}
      />
    </div>
  );
}

export function BrightnessSlider({ device, light, compact }: { device: DeviceDTO; light: LightState; compact?: boolean }) {
  const t = useT();
  const run = useCommand();
  const pending = usePending(device.id, light.endpointId, 'levelControl');
  return (
    <CommandSlider
      label={t('dev.brightness')}
      value={light.percent}
      min={1}
      max={100}
      pending={pending}
      disabled={device.availability === 'offline'}
      compact={compact}
      format={(v) => `${v}%`}
      onSend={(pct) => void run(device.id, light.endpointId, 'levelControl', 'moveToLevel', { level: percentToLevel(pct) })}
    />
  );
}

export function ColorTempSlider({ device, light }: { device: DeviceDTO; light: LightState }) {
  const t = useT();
  const run = useCommand();
  const pending = usePending(device.id, light.endpointId, 'colorControl');
  const [lo, hi] = light.kelvinRange;
  return (
    <CommandSlider
      label={t('dev.colorTemp')}
      value={light.kelvin === undefined ? undefined : Math.min(hi, Math.max(lo, light.kelvin))}
      min={lo}
      max={hi}
      step={50}
      pending={pending}
      disabled={device.availability === 'offline'}
      format={(v) => `${Math.round(v / 10) * 10} K`}
      track={`linear-gradient(to right, ${kelvinColor(lo)}, ${kelvinColor((lo + hi) / 2)}, ${kelvinColor(hi)})`}
      onSend={(k) => void run(device.id, light.endpointId, 'colorControl', 'moveToColorTemperature', { colorTemperatureMireds: kelvinToMireds(k) })}
    />
  );
}

const HUE_TRACK = 'linear-gradient(to right, oklch(0.75 0.15 0), oklch(0.75 0.15 60), oklch(0.75 0.15 120), oklch(0.75 0.15 180), oklch(0.75 0.15 240), oklch(0.75 0.15 300), oklch(0.75 0.15 360))';
const SWATCHES = [10, 35, 60, 130, 200, 250, 290, 330];

/** Hue slider + quick swatches for extended color lights. Hue degrees follow Matter's HSV hue. */
export function HuePicker({ device, light }: { device: DeviceDTO; light: LightState }) {
  const t = useT();
  const run = useCommand();
  const pending = usePending(device.id, light.endpointId, 'colorControl');
  const offline = device.availability === 'offline';
  const sat = light.satPct && light.satPct > 10 ? light.satPct : 100;
  const send = (deg: number) => void run(device.id, light.endpointId, 'colorControl', 'moveToHueAndSaturation', { hue: degreesToHue(deg), saturation: percentToSat(sat) });
  const inHs = light.colorMode === 'hs' || light.colorMode === 'xy';
  return (
    <div className="flex flex-col gap-2.5">
      <CommandSlider
        label={t('dev.hue')}
        value={light.hueDeg ?? 0}
        min={0}
        max={359}
        pending={pending}
        disabled={offline}
        format={(v) => `${v}°`}
        track={HUE_TRACK}
        onSend={send}
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('dev.hue')}>
        {SWATCHES.map((deg) => {
          const selected = inHs && light.hueDeg !== undefined && Math.abs(light.hueDeg - deg) < 8;
          return (
            <button
              key={deg}
              type="button"
              disabled={offline || pending}
              aria-label={`${deg}°`}
              aria-pressed={selected}
              onClick={() => send(deg)}
              className={cx(
                'size-8 rounded-full border-2 transition-transform duration-fast hover:scale-110 disabled:opacity-50',
                selected ? 'border-ink' : 'border-surface',
              )}
              style={{ background: `hsl(${deg} 85% 62%)`, boxShadow: '0 0 0 1px var(--line)' }}
            />
          );
        })}
      </div>
    </div>
  );
}
