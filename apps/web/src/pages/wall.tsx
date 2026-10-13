import { useEffect, useMemo, useState } from 'react';
import type { WallSettings } from '@livynq/model';
import { DeviceSheet } from '../components/device-sheet.tsx';
import { GlassContext, glassBackground } from '../components/glass.tsx';
import { Icon } from '../components/icons.tsx';
import { Sheet } from '../components/sheet.tsx';
import { IconButton, cx } from '../components/ui.tsx';
import { WallSettingsForm } from '../components/wall-settings-form.tsx';
import { withToken } from '../lib/api.ts';
import { formatDateLine, formatTime } from '../lib/format.ts';
import { useLang, useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { setWall } from '../lib/prefs.ts';
import { href } from '../lib/router.ts';
import { useWallLook } from '../lib/wall-settings.ts';
import { DeviceGrid, groupByRoom, useNow, useSummary } from './home.tsx';

/** Full-screen background image with the configured blur and dimming. */
function WallBackdrop({ look }: { look: WallSettings }) {
  const bg = look.background;
  const [loaded, setLoaded] = useState<string | null>(null);
  const url = bg ? withToken(bg.url) : null;
  // Fade the image in once decoded instead of painting it top to bottom.
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setLoaded(url);
    img.src = url;
  }, [url]);
  if (!url) return null;
  const blur = look.backgroundBlur;
  return (
    <div className="fixed inset-0 overflow-hidden" aria-hidden="true">
      <div
        className={cx('absolute bg-cover bg-center transition-[filter,opacity] duration-slow', loaded === url ? 'opacity-100' : 'opacity-0')}
        // Extend past the edges when blurred so the borders do not fade to transparent.
        style={{ backgroundImage: `url("${url}")`, filter: blur ? `blur(${blur}px)` : undefined, inset: -blur * 2 }}
      />
      <div className="absolute inset-0 transition-colors duration-slow" style={{ background: `oklch(0 0 0 / ${look.backgroundDim})` }} />
    </div>
  );
}

/** Wall / kiosk mode: dark, full screen, big clock, room-grouped cards; optional photo background with glass cards. */
export function WallPage() {
  const t = useT();
  const lang = useLang();
  const { devices: byId, rooms } = useLive();
  const devices = useMemo(() => Object.values(byId), [byId]);
  const now = useNow(5_000);
  const summary = useSummary(devices, rooms, t);
  const [open, setOpen] = useState<string | null>(null);
  const [customize, setCustomize] = useState(false);
  const look = useWallLook();
  const hasImage = look.background !== null;
  const glass = useMemo(() => (hasImage ? { opacity: look.cardOpacity } : null), [hasImage, look.cardOpacity]);

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

  const panel = glass ? { background: glassBackground(undefined, glass.opacity) } : undefined;
  const chipBtn = cx('rounded-[14px] transition-colors duration-base', glass && 'lv-glass');

  return (
    <div className={cx('relative min-h-dvh bg-bg text-ink', hasImage && 'lv-wall-glass')}>
      <WallBackdrop look={look} />
      <GlassContext.Provider value={glass}>
        <div className="relative px-[18px] py-10 md:px-12">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className={cx(glass && 'lv-glass rounded-panel border border-line px-6 py-5 md:px-8 md:py-6')} style={panel}>
                <div className={cx('text-[72px] leading-none font-light tracking-[-0.04em] tabular-nums md:text-[112px]', !glass && hasImage && 'lv-shadow-text')}>
                  {formatTime(now.getTime(), lang)}
                </div>
                <div className="mt-2 text-base font-semibold text-muted">
                  {formatDateLine(now, lang)}
                  {summary.indoor ? ` · ${t('home.indoor', { t: summary.indoor })}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <IconButton
                  icon="sliders"
                  label={t('wall.customize')}
                  onClick={() => setCustomize(true)}
                  className={cx('size-12! rounded-[14px]!', chipBtn)}
                  style={glass ? { background: glassBackground('var(--chip)', Math.max(glass.opacity, 0.5)) } : undefined}
                />
                <a
                  href={href('home')}
                  className={cx('flex min-h-12 items-center gap-2 bg-chip px-[18px] py-3 text-sm font-bold text-ink! no-underline hover:bg-line', chipBtn)}
                >
                  <Icon name="x" size={16} />
                  {t('home.exitWall')}
                </a>
              </div>
            </div>
            {groupByRoom(devices, rooms, t('home.other')).map((g) => (
              <section key={g.id} aria-label={g.name} className="flex flex-col gap-3">
                <h2 className={cx('m-0 text-lg font-extrabold', hasImage ? 'lv-shadow-text text-ink' : 'text-muted')}>{g.name}</h2>
                <DeviceGrid devices={g.devices} onOpen={setOpen} large />
              </section>
            ))}
          </div>
        </div>
      </GlassContext.Provider>
      {open && <DeviceSheet deviceId={open} onClose={() => setOpen(null)} />}
      {customize && (
        <Sheet label={t('wall.customize')} onClose={() => setCustomize(false)} clearOverlay>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="m-0 text-xl font-extrabold tracking-[-0.02em]">{t('wall.title')}</h2>
              <p className="mt-1 mb-0 text-[13px] leading-relaxed text-muted">{t('wall.subtitle')}</p>
            </div>
            <IconButton icon="x" label={t('common.close')} onClick={() => setCustomize(false)} />
          </div>
          <WallSettingsForm preview={false} />
        </Sheet>
      )}
    </div>
  );
}
