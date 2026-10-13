import { useEffect, useRef, useState } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { FAN_MODES, round1, runningColor, type ClimateState, type CoverState, type FanState, type LockStateValue, type RunningState, type SystemMode } from '../lib/devices.ts';
import { formatRelative } from '../lib/format.ts';
import { useLang, useT } from '../lib/i18n.ts';
import { useCan } from '../lib/session.ts';
import { confirmDialog } from './dialog.tsx';
import { CommandSlider, useCommand, usePending } from './device-controls.tsx';
import { Icon, type IconName } from './icons.tsx';
import { Button, Spinner, cx } from './ui.tsx';

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/** Re-renders every `ms` (relative times). */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Tracks which command of a group was clicked last, so its button can show the spinner
 * while the capability is pending (several buttons share one pending key).
 */
function useClicked<T>(pending: boolean): [T | null, (v: T) => void] {
  const [clicked, setClicked] = useState<T | null>(null);
  const seen = useRef(false);
  useEffect(() => {
    if (pending) seen.current = true;
    else if (seen.current) {
      seen.current = false;
      setClicked(null);
    }
  }, [pending]);
  return [clicked, setClicked];
}

// ---------------------------------------------------------------- covers

/** Position bar: fill = how open it is; while moving, a marker shows where it is heading. */
export function CoverBar({ cover, className }: { cover: CoverState; className?: string }) {
  const pos = cover.position ?? 0;
  const moving = cover.motion !== 'stopped';
  return (
    <div
      className={cx('relative h-2 overflow-hidden rounded-full bg-chip', className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={cover.position}
      aria-busy={moving || undefined}
    >
      <div className={cx('absolute inset-y-0 left-0 rounded-full bg-amber transition-[width] duration-300 ease-linear', moving && 'lv-moving')} style={{ width: `${pos}%` }} />
      {moving && cover.target !== undefined && (
        <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-ink/70" style={{ left: `${Math.min(99, Math.max(1, cover.target))}%` }} aria-hidden="true" />
      )}
    </div>
  );
}

type CoverCommand = 'open' | 'stop' | 'close';

export function CoverButtons({ device, cover, garage, labels, large }: { device: DeviceDTO; cover: CoverState; garage?: boolean; labels?: boolean; large?: boolean }) {
  const t = useT();
  const run = useCommand();
  const canControl = useCan('control');
  const pending = usePending(device.id, cover.endpointId, 'windowCovering');
  const [clicked, setClicked] = useClicked<CoverCommand>(pending);
  const offline = device.availability === 'offline';
  const moving = cover.motion !== 'stopped';
  const send = (cmd: CoverCommand) => {
    setClicked(cmd);
    void run(device.id, cover.endpointId, 'windowCovering', cmd);
  };
  const items: { cmd: CoverCommand; icon: IconName; label: string; current: boolean }[] = [
    { cmd: 'open', icon: 'arrowUpToLine', label: t('cover.open'), current: !moving && cover.position === 100 },
    { cmd: 'stop', icon: 'stop', label: t('cover.stop'), current: false },
    { cmd: 'close', icon: 'arrowDownToLine', label: t('cover.close'), current: !moving && cover.position === 0 },
  ];
  // Garage doors and gates: two clear actions; stop only while it moves.
  const shown = garage ? items.filter((i) => i.cmd !== 'stop' || moving) : items;
  return (
    <div className="flex gap-1.5" onClick={stop} role="group" aria-label={device.name}>
      {shown.map((i) => {
        const busy = pending && clicked === i.cmd;
        const active = (i.cmd === 'open' && cover.motion === 'opening') || (i.cmd === 'close' && cover.motion === 'closing');
        return (
          <button
            key={i.cmd}
            type="button"
            aria-label={i.label}
            title={i.label}
            aria-busy={busy || undefined}
            disabled={offline || !canControl || (pending && clicked !== null)}
            onClick={() => send(i.cmd)}
            className={cx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border-0 font-bold transition-[background-color,color,opacity] duration-base disabled:cursor-not-allowed disabled:opacity-50',
              large || labels ? 'min-h-11 text-[13px]' : 'min-h-9 text-xs',
              active ? 'bg-amber text-on-amber' : i.current ? 'bg-chip text-muted' : 'bg-chip text-ink hover:bg-line',
            )}
          >
            {busy ? <Spinner size={15} /> : <Icon name={i.icon} size={large ? 17 : 15} />}
            {(labels || garage) && <span>{i.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function CoverPositionSlider({ device, cover }: { device: DeviceDTO; cover: CoverState }) {
  const t = useT();
  const run = useCommand();
  const canControl = useCan('control');
  const pending = usePending(device.id, cover.endpointId, 'windowCovering');
  return (
    <CommandSlider
      label={t('dev.position')}
      value={cover.position}
      min={0}
      max={100}
      step={5}
      pending={pending || cover.motion !== 'stopped'}
      disabled={device.availability === 'offline' || !canControl}
      format={(v) => `${v}%`}
      onSend={(position) => void run(device.id, cover.endpointId, 'windowCovering', 'goToPosition', { position })}
    />
  );
}

// ---------------------------------------------------------------- climate

const modeIcon: Record<SystemMode, IconName> = { off: 'power', heat: 'flame', cool: 'snowflake', auto: 'sparkles', dry: 'droplet', fan_only: 'fan' };

export function RunningPill({ running, className }: { running: RunningState; className?: string }) {
  const t = useT();
  const color = runningColor(running);
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full bg-chip px-2 py-1 text-[11px] font-bold whitespace-nowrap text-ink', className)}>
      <span
        className={cx('inline-block size-[7px] shrink-0 rounded-full', color && 'lv-pulse')}
        style={{ background: color ?? (running === 'idle' ? 'var(--muted)' : 'var(--ok)') }}
        aria-hidden="true"
      />
      {t(`climate.running.${running}`)}
    </span>
  );
}

/** Target temperature with −/+ in 0.5° steps. The draft shows dimmed until the device confirms. */
export function TargetStepper({ device, climate, large }: { device: DeviceDTO; climate: ClimateState; large?: boolean }) {
  const t = useT();
  const run = useCommand();
  const canControl = useCan('control');
  const pending = usePending(device.id, climate.endpointId, 'thermostat');
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sent, setSent] = useState(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (draft !== null && !pending && timer.current === undefined) setDraft(null);
  }, [pending, draft, sent]);

  const shown = draft ?? climate.target;
  const disabled = device.availability === 'offline' || !canControl || shown === undefined;
  const bump = (delta: number) => {
    if (shown === undefined) return;
    const next = Math.min(climate.max, Math.max(climate.min, Math.round((shown + delta) * 2) / 2));
    if (next === shown) return;
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void run(device.id, climate.endpointId, 'thermostat', 'setTargetTemperature', { temperature: next });
      setSent((n) => n + 1);
    }, 450);
  };
  const btn = cx(
    'grid shrink-0 place-items-center rounded-full border-0 text-ink transition-colors duration-base disabled:cursor-not-allowed disabled:opacity-40',
    // Large lives on a chip-colored panel (device sheet), so it needs a raised surface to stand out.
    large ? 'size-12 bg-surface shadow-card hover:bg-surface2' : 'size-9 bg-chip hover:bg-line',
  );
  const waiting = draft !== null || pending;
  return (
    <div className="flex items-center gap-2" onClick={stop}>
      <button type="button" className={btn} aria-label={t('climate.cooler')} disabled={disabled || (shown ?? 0) <= climate.min} onClick={() => bump(-0.5)}>
        <Icon name="minus" size={large ? 20 : 16} />
      </button>
      <div className="flex min-w-0 flex-col items-center" aria-live="polite">
        <span className={cx('font-light tracking-[-0.03em] tabular-nums transition-opacity duration-base', large ? 'text-[40px] leading-none' : 'text-[22px] leading-tight', waiting && 'opacity-60')}>
          {shown === undefined ? '—' : `${shown.toFixed(1)}°`}
        </span>
        <span className="flex items-center gap-1 text-[11px] font-semibold text-muted">
          {t('climate.target')}
          {waiting && <Spinner size={10} />}
        </span>
      </div>
      <button type="button" className={btn} aria-label={t('climate.warmer')} disabled={disabled || (shown ?? 0) >= climate.max} onClick={() => bump(0.5)}>
        <Icon name="plus" size={large ? 20 : 16} />
      </button>
    </div>
  );
}

export function ModeChips({ device, climate, labels }: { device: DeviceDTO; climate: ClimateState; labels?: boolean }) {
  const t = useT();
  const run = useCommand();
  const canControl = useCan('control');
  const pending = usePending(device.id, climate.endpointId, 'thermostat');
  const [clicked, setClicked] = useClicked<SystemMode>(pending);
  const offline = device.availability === 'offline';
  return (
    <div className={cx('flex gap-1', labels && 'flex-wrap')} role="radiogroup" aria-label={t('dev.mode')} onClick={stop}>
      {climate.modes.map((m) => {
        const on = climate.mode === m;
        const busy = pending && clicked === m;
        const tint = on && m === 'heat' ? 'heat' : on && m === 'cool' ? 'cool' : undefined;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={t(`climate.mode.${m}`)}
            title={t(`climate.mode.${m}`)}
            disabled={offline || !canControl || (pending && clicked !== null)}
            onClick={() => {
              if (on) return;
              setClicked(m);
              void run(device.id, climate.endpointId, 'thermostat', 'setSystemMode', { mode: m });
            }}
            className={cx(
              'flex items-center justify-center gap-1.5 rounded-[10px] border-0 font-bold transition-[background-color,color] duration-base disabled:cursor-not-allowed disabled:opacity-50',
              labels ? 'min-h-10 px-3 text-[13px]' : 'size-9 shrink-0',
              on ? (tint ? 'text-white' : 'bg-ink text-bg') : 'bg-chip text-ink hover:bg-line',
            )}
            style={tint ? { background: runningColor(tint === 'heat' ? 'heating' : 'cooling') } : undefined}
          >
            {busy ? <Spinner size={15} /> : <Icon name={modeIcon[m]} size={15} />}
            {labels && t(`climate.mode.${m}`)}
          </button>
        );
      })}
    </div>
  );
}

/** Current room temperature, large and light like the prototype's readings. */
export function CurrentTemp({ climate, large }: { climate: ClimateState; large?: boolean }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-col">
      <span className={cx('font-light tracking-[-0.04em] tabular-nums', large ? 'text-[56px] leading-none' : 'text-[34px] leading-none')}>
        {climate.current === undefined ? '—' : `${round1(climate.current)}°`}
      </span>
      <span className="mt-1 text-[11px] font-semibold text-muted">{t('dev.roomTemp')}</span>
    </div>
  );
}

// ---------------------------------------------------------------- fans

export function FanSpeedSlider({ device, fan, compact }: { device: DeviceDTO; fan: FanState; compact?: boolean }) {
  const t = useT();
  const run = useCommand();
  const canControl = useCan('control');
  const pending = usePending(device.id, fan.endpointId, 'fanControl');
  return (
    <CommandSlider
      label={t('dev.fanSpeed')}
      value={fan.percent}
      min={1}
      max={100}
      pending={pending}
      compact={compact}
      disabled={device.availability === 'offline' || !canControl}
      format={(v) => `${v}%`}
      onSend={(percent) => void run(device.id, fan.endpointId, 'fanControl', 'setPercent', { percent })}
    />
  );
}

export function FanModeChips({ device, fan }: { device: DeviceDTO; fan: FanState }) {
  const t = useT();
  const run = useCommand();
  const canControl = useCan('control');
  const pending = usePending(device.id, fan.endpointId, 'fanControl');
  const [clicked, setClicked] = useClicked<string>(pending);
  return (
    <div className="flex gap-1 rounded-[13px] bg-chip p-1" role="radiogroup" aria-label={t('dev.fanMode')}>
      {FAN_MODES.map((m) => {
        const on = fan.mode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={device.availability === 'offline' || !canControl || (pending && clicked !== null)}
            onClick={() => {
              if (on) return;
              setClicked(m);
              void run(device.id, fan.endpointId, 'fanControl', 'setMode', { mode: m });
            }}
            className={cx(
              'flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-[10px] border-0 text-[13px] font-bold transition-[background-color,color,box-shadow] duration-base disabled:cursor-not-allowed',
              on ? 'bg-surface text-ink shadow-card' : 'bg-transparent text-muted hover:text-ink',
            )}
          >
            {pending && clicked === m && <Spinner size={13} />}
            {t(`fan.mode.${m}`)}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- locks

/** Lock / unlock. Unlocking always asks first, whoever is holding the tablet. */
export function LockButton({ device, endpointId, state, large }: { device: DeviceDTO; endpointId: number; state: LockStateValue; large?: boolean }) {
  const t = useT();
  const run = useCommand();
  const canControl = useCan('control');
  const pending = usePending(device.id, endpointId, 'doorLock');
  const [clicked, setClicked] = useClicked<'lock' | 'unlock'>(pending);
  const offline = device.availability === 'offline';
  const actions: ('lock' | 'unlock')[] = state === 'unlocked' ? ['lock'] : state === 'locked' ? ['unlock'] : ['lock', 'unlock'];

  const act = async (cmd: 'lock' | 'unlock') => {
    if (cmd === 'unlock') {
      const ok = await confirmDialog({
        title: t('lock.confirmTitle', { name: device.name }),
        body: t('lock.confirmBody'),
        confirmLabel: t('lock.unlock'),
        icon: 'lockOpen',
        danger: true,
      });
      if (!ok) return;
    }
    setClicked(cmd);
    void run(device.id, endpointId, 'doorLock', cmd);
  };

  return (
    <div className="flex gap-1.5" onClick={stop}>
      {actions.map((cmd) => (
        <Button
          key={cmd}
          size={large ? 'md' : 'sm'}
          variant={cmd === 'lock' ? 'amber' : 'chip'}
          icon={cmd === 'lock' ? 'lock' : 'lockOpen'}
          busy={pending && clicked === cmd}
          disabled={offline || !canControl || pending}
          onClick={() => void act(cmd)}
          className={cx('flex-1', large && 'min-h-12 text-[15px]')}
        >
          {t(cmd === 'lock' ? 'lock.lock' : 'lock.unlock')}
        </Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- buttons

/** True for a moment whenever a new press arrives (not on first render). */
export function usePressFlash(at: number | undefined): boolean {
  const prev = useRef(at);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (at === prev.current) return;
    prev.current = at;
    if (at === undefined) return;
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(id);
  }, [at]);
  return flash;
}

export function PressTime({ at }: { at: number | undefined }) {
  const lang = useLang();
  useTick(15_000);
  if (at === undefined) return null;
  return <>{formatRelative(Math.min(at, Date.now()), lang)}</>;
}
