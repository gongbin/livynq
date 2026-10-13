import { useEffect, useMemo, useState } from 'react';
import { DeviceSheet } from '../components/device-sheet.tsx';
import { Icon } from '../components/icons.tsx';
import { formatDateLine, formatTime } from '../lib/format.ts';
import { useLang, useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { setWall } from '../lib/prefs.ts';
import { href } from '../lib/router.ts';
import { DeviceGrid, groupByRoom, useNow, useSummary } from './home.tsx';

/** Wall / kiosk mode: dark, full screen, big clock, room-grouped cards. */
export function WallPage() {
  const t = useT();
  const lang = useLang();
  const { devices: byId, rooms } = useLive();
  const devices = useMemo(() => Object.values(byId), [byId]);
  const now = useNow(5_000);
  const summary = useSummary(devices, rooms, t);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setWall(true);
    // Keep the tablet awake while on the wall, where supported.
    let lock: { release(): Promise<void> } | undefined;
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => {
      setWall(false);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  return (
    <div className="min-h-dvh bg-bg px-[18px] py-10 text-ink md:px-12">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[72px] leading-none font-light tracking-[-0.04em] tabular-nums md:text-[112px]">{formatTime(now.getTime(), lang)}</div>
            <div className="mt-2 text-base font-semibold text-muted">
              {formatDateLine(now, lang)}
              {summary.indoor ? ` · ${t('home.indoor', { t: summary.indoor })}` : ''}
            </div>
          </div>
          <a
            href={href('home')}
            className="flex items-center gap-2 rounded-[14px] bg-chip px-[18px] py-3 text-sm font-bold text-ink! no-underline transition-colors duration-base hover:bg-line"
          >
            <Icon name="x" size={16} />
            {t('home.exitWall')}
          </a>
        </div>
        {groupByRoom(devices, rooms, t('home.other')).map((g) => (
          <section key={g.id} aria-label={g.name} className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-extrabold text-muted">{g.name}</h2>
            <DeviceGrid devices={g.devices} onOpen={setOpen} large />
          </section>
        ))}
      </div>
      {open && <DeviceSheet deviceId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
