import type { CSSProperties, ReactNode } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { describe, type DeviceView } from '../lib/devices.ts';
import { useT } from '../lib/i18n.ts';
import { CoverBar, CoverButtons, CurrentTemp, FanSpeedSlider, LockButton, ModeChips, PressTime, RunningPill, TargetStepper, usePressFlash } from './appliance-controls.tsx';
import { BrightnessSlider, useAnyPending, useCommand, usePending } from './device-controls.tsx';
import { glassBackground, useGlass } from './glass.tsx';
import { Icon } from './icons.tsx';
import { Spinner, Switch, cx } from './ui.tsx';

/** Visual treatment per tone; lit lights take on their own color as a soft glow. */
export function toneStyle(v: DeviceView): { card: CSSProperties; icon: CSSProperties; lit: boolean } {
  if (v.tone === 'alert') {
    return { card: { background: 'var(--alert-soft)', borderColor: 'transparent' }, icon: { background: 'var(--alert)', color: '#fff' }, lit: true };
  }
  if (v.tone === 'active') {
    const glow = v.glow;
    const tinted = glow && glow !== 'var(--amber)';
    return {
      card: {
        background: tinted ? `color-mix(in oklab, ${glow} var(--glow-mix, 26%), var(--surface))` : 'var(--amber-soft)',
        borderColor: 'transparent',
        boxShadow: tinted ? `var(--shadow), 0 8px 28px -12px ${glow}` : undefined,
      },
      icon: { background: glow ?? 'var(--amber)', color: 'var(--on-amber)' },
      lit: true,
    };
  }
  return { card: {}, icon: { background: 'var(--chip)', color: 'var(--muted)' }, lit: false };
}

/** Cards that carry more controls take two grid columns. */
export const isWideCard = (v: DeviceView) => v.kind === 'climate';

export function DeviceCard({ device, roomLabel, onOpen, large }: { device: DeviceDTO; roomLabel?: string; onOpen: () => void; large?: boolean }) {
  const t = useT();
  const run = useCommand();
  const glass = useGlass();
  const v = describe(device, t);
  const style = toneStyle(v);
  const offline = v.tone === 'offline';
  const togglePending = usePending(device.id, v.toggleEndpoint, 'onOff');
  const anyPending = useAnyPending(device);
  const flash = usePressFlash(v.button?.at);
  const toggle = () => {
    if (v.toggleEndpoint === undefined || togglePending) return;
    void run(device.id, v.toggleEndpoint, 'onOff', v.on ? 'off' : 'on');
  };
  const moving = v.cover !== undefined && v.cover.motion !== 'stopped';

  const cardStyle: CSSProperties = glass
    ? { ...style.card, background: glassBackground(style.card.background as string | undefined, glass.opacity), borderColor: undefined }
    : style.card;

  let extra: ReactNode = null;
  if (!offline) {
    if (v.kind === 'light' && v.light?.percent !== undefined && v.on && v.light) {
      extra = <BrightnessSlider device={device} light={v.light} compact />;
    } else if (v.kind === 'fan' && v.on && v.fan?.percent !== undefined) {
      extra = <FanSpeedSlider device={device} fan={v.fan} compact />;
    } else if ((v.kind === 'cover' || v.kind === 'garage') && v.cover) {
      extra = (
        <div className="flex flex-col gap-2.5">
          {v.kind === 'cover' && <CoverBar cover={v.cover} />}
          <CoverButtons device={device} cover={v.cover} garage={v.kind === 'garage'} large={large} />
        </div>
      );
    } else if (v.kind === 'climate' && v.climate) {
      extra = (
        <div className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <CurrentTemp climate={v.climate} large={large} />
            <TargetStepper device={device} climate={v.climate} />
          </div>
          <ModeChips device={device} climate={v.climate} />
        </div>
      );
    } else if (v.kind === 'lock' && v.lock) {
      const ep = device.endpoints.find((e) => e.capabilities.includes('doorLock'));
      if (ep) extra = <LockButton device={device} endpointId={ep.id} state={v.lock} large={large} />;
    }
  }

  return (
    <div
      onClick={onOpen}
      className={cx(
        'group flex cursor-pointer flex-col gap-3.5 rounded-card border border-line bg-surface p-3.5 shadow-card transition-[background-color,border-color,box-shadow,opacity] duration-slow hover:border-wall/40',
        glass && 'lv-glass',
        offline && 'opacity-65',
        large && 'p-5',
        isWideCard(v) && 'col-span-2',
        flash && 'lv-press-flash',
      )}
      style={cardStyle}
    >
      <div className="flex items-start justify-between gap-2">
        {v.toggleEndpoint !== undefined ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            disabled={offline}
            aria-label={`${device.name}: ${v.on ? t('common.off') : t('common.on')}`}
            className={cx('grid place-items-center rounded-[13px] border-0 transition-[background-color,color,transform] duration-slow active:scale-95 disabled:cursor-not-allowed', large ? 'size-12' : 'size-10')}
            style={style.icon}
          >
            <Icon name={v.icon} size={large ? 22 : 19} className={v.kind === 'fan' && v.on ? 'lv-spin-slow' : undefined} />
          </button>
        ) : (
          <span className={cx('grid place-items-center rounded-[13px] transition-colors duration-slow', large ? 'size-12' : 'size-10', flash && 'lv-press-icon')} style={flash ? undefined : style.icon}>
            <Icon name={v.icon} size={large ? 22 : 19} />
          </span>
        )}
        {offline ? (
          <span className="flex items-center gap-1 rounded-full bg-chip px-2 py-1 text-[11px] font-bold text-muted" title={v.stateText}>
            <Icon name="wifiOff" size={13} />
          </span>
        ) : v.toggleEndpoint !== undefined ? (
          <span className="py-[9px] pl-2">
            <Switch checked={v.on ?? false} pending={togglePending} onChange={toggle} label={device.name} />
          </span>
        ) : v.climate && v.climate.mode && v.climate.mode !== 'off' ? (
          <RunningPill running={v.climate.running} />
        ) : null}
      </div>
      <div className="min-w-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="block max-w-full truncate border-0 bg-transparent p-0 text-left text-[14.5px] leading-snug font-bold text-ink"
        >
          {device.name}
        </button>
        <div className="mt-[3px] flex items-center gap-1.5 text-[12.5px] text-muted">
          <span className="truncate">
            {roomLabel ? `${roomLabel} · ` : ''}
            {v.stateText}
            {v.button?.at !== undefined && (
              <>
                {' · '}
                <PressTime at={v.button.at} />
              </>
            )}
          </span>
          {(anyPending || moving) && <Spinner size={12} className="shrink-0" />}
        </div>
      </div>
      {extra && (
        <div className="-mt-1.5" onClick={(e) => e.stopPropagation()}>
          {extra}
        </div>
      )}
    </div>
  );
}
