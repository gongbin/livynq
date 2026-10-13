import type { CSSProperties } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { describe, type DeviceView } from '../lib/devices.ts';
import { useT } from '../lib/i18n.ts';
import { BrightnessSlider, useAnyPending, useCommand, usePending } from './device-controls.tsx';
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

export function DeviceCard({ device, roomLabel, onOpen, large }: { device: DeviceDTO; roomLabel?: string; onOpen: () => void; large?: boolean }) {
  const t = useT();
  const run = useCommand();
  const v = describe(device, t);
  const style = toneStyle(v);
  const offline = v.tone === 'offline';
  const togglePending = usePending(device.id, v.toggleEndpoint, 'onOff');
  const anyPending = useAnyPending(device);
  const toggle = () => {
    if (v.toggleEndpoint === undefined || togglePending) return;
    void run(device.id, v.toggleEndpoint, 'onOff', v.on ? 'off' : 'on');
  };
  const showSlider = v.kind === 'light' && v.light?.percent !== undefined && v.on && !offline;

  return (
    <div
      onClick={onOpen}
      className={cx(
        'group flex cursor-pointer flex-col gap-3.5 rounded-card border border-line bg-surface p-3.5 shadow-card transition-[background-color,border-color,box-shadow,opacity] duration-slow hover:border-wall/40',
        offline && 'opacity-65',
        large && 'p-5',
      )}
      style={style.card}
    >
      <div className="flex items-start justify-between">
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
            <Icon name={v.icon} size={large ? 22 : 19} />
          </button>
        ) : (
          <span className={cx('grid place-items-center rounded-[13px] transition-colors duration-slow', large ? 'size-12' : 'size-10')} style={style.icon}>
            <Icon name={v.icon} size={large ? 22 : 19} />
          </span>
        )}
        {offline ? (
          <span className="flex items-center gap-1 rounded-full bg-chip px-2 py-1 text-[11px] font-bold text-muted" title={v.stateText}>
            <Icon name="wifiOff" size={13} />
          </span>
        ) : (
          v.toggleEndpoint !== undefined && (
            <span className="py-[9px] pl-2">
              <Switch checked={v.on ?? false} pending={togglePending} onChange={toggle} label={device.name} />
            </span>
          )
        )}
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
          </span>
          {anyPending && <Spinner size={12} className="shrink-0" />}
        </div>
      </div>
      {showSlider && v.light && (
        <div className="-mt-1.5" onClick={(e) => e.stopPropagation()}>
          <BrightnessSlider device={device} light={v.light} compact />
        </div>
      )}
    </div>
  );
}
