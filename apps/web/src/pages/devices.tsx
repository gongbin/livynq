import { useDeferredValue, useMemo, useState } from 'react';
import { DeviceSheet } from '../components/device-sheet.tsx';
import { toneStyle } from '../components/device-card.tsx';
import { Icon } from '../components/icons.tsx';
import { Card, Dot, EmptyState, PageHeader, Spinner } from '../components/ui.tsx';
import { describe, primaryEntity, roomName, sortDevices } from '../lib/devices.ts';
import { useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';

export function DevicesPage() {
  const t = useT();
  const { devices: byId, rooms, ready } = useLive();
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim().toLowerCase());
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = sortDevices(Object.values(byId)).map((d) => ({ d, room: roomName(d, rooms) ?? '', entity: primaryEntity(d) }));
    if (!q) return all;
    return all.filter(({ d, room }) =>
      [d.name, d.id, room, d.protocol, d.adapter, ...d.aliases, ...Object.values(d.entities)].some((s) => s.toLowerCase().includes(q)),
    );
  }, [byId, rooms, q]);

  return (
    <>
      <PageHeader title={t('devices.title')} subtitle={t('devices.subtitle')} />
      <div className="relative">
        <Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('devices.search')}
          aria-label={t('devices.search')}
          className="min-h-12 w-full rounded-tile border border-line bg-surface pr-4 pl-10 text-sm text-ink shadow-card outline-none placeholder:text-muted focus:border-amber-ink"
        />
      </div>
      <Card className="p-1.5! md:p-2!">
        {!ready ? (
          <div className="grid place-items-center py-12 text-muted">
            <Spinner size={20} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="search" title={Object.keys(byId).length ? t('devices.noMatch') : t('home.empty.title')} />
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,1fr)_90px_110px] gap-3 px-3 pt-2 pb-1.5 text-[11px] font-extrabold tracking-[0.06em] text-muted uppercase lg:grid">
              <span>{t('dev.name')}</span>
              <span>{t('dev.entities')}</span>
              <span>{t('dev.room')}</span>
              <span>{t('dev.protocol')}</span>
              <span>{t('dev.status')}</span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {rows.map(({ d, room, entity }) => {
                const v = describe(d, t);
                const style = toneStyle(v);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setOpen(d.id)}
                      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[15px] border-0 bg-transparent p-3 text-left text-ink transition-colors duration-base hover:bg-surface2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,1fr)_90px_110px]"
                    >
                      <span className="flex min-w-0 items-center gap-3 max-lg:contents">
                        <span className="grid size-9 shrink-0 place-items-center rounded-[11px] transition-colors duration-slow" style={style.icon}>
                          <Icon name={v.icon} size={17} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[14.5px] font-bold">{d.name}</span>
                          <span className="block truncate text-[12.5px] text-muted lg:hidden">
                            {[room, d.protocol, v.stateText].filter(Boolean).join(' · ')}
                          </span>
                          <span className="block truncate font-mono text-[11.5px] text-muted lg:hidden">{entity}</span>
                          <span className="hidden truncate text-[12.5px] text-muted lg:block">{v.stateText}</span>
                        </span>
                      </span>
                      <span className="hidden truncate font-mono text-xs text-muted lg:block">{entity}</span>
                      <span className="hidden truncate text-[13px] lg:block">{room || '—'}</span>
                      <span className="hidden text-[13px] text-muted lg:block">{d.protocol}</span>
                      <span className="flex items-center gap-1.5 justify-self-end text-xs font-semibold text-muted lg:justify-self-start">
                        <Dot tone={d.availability === 'online' ? 'ok' : d.availability === 'offline' ? 'alert' : 'muted'} />
                        <span className="max-sm:sr-only">
                          {d.availability === 'online' ? t('common.online') : d.availability === 'offline' ? t('common.offline') : t('common.unknown')}
                        </span>
                        <Icon name="chevronRight" size={16} className="lg:hidden" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>
      {ready && <div className="text-center text-xs text-muted">{t('devices.count', { n: rows.length })}</div>}
      {open && <DeviceSheet deviceId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
