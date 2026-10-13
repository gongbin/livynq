import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeviceDTO, Room } from '@livynq/model';
import { DeviceCard } from '../components/device-card.tsx';
import { DeviceSheet } from '../components/device-sheet.tsx';
import { Icon } from '../components/icons.tsx';
import { HomeSpace } from '../components/plan/home-space.tsx';
import { Button, EmptyState, Segmented, cx } from '../components/ui.tsx';
import { openAddDevice } from '../lib/add-device.ts';
import { deviceKind, lightState, readings, round1, sortDevices } from '../lib/devices.ts';
import { readView, writeView, type HomeView } from '../lib/floorplan.ts';
import { formatDateLine } from '../lib/format.ts';
import { useLang, useT, type Translate } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { href } from '../lib/router.ts';
import { useCan } from '../lib/session.ts';

const OTHER = '__other';
const VIEW_KEY = 'livynq.home.view';

export interface RoomGroup {
  id: string;
  name: string;
  devices: DeviceDTO[];
}

/** Rooms in their sort order (only those with devices), then unassigned devices as "Other". */
export function groupByRoom(devices: DeviceDTO[], rooms: Room[], otherLabel: string): RoomGroup[] {
  const sorted = sortDevices(devices);
  const groups: RoomGroup[] = rooms.map((r) => ({ id: r.id, name: r.name, devices: sorted.filter((d) => d.roomId === r.id) }));
  const known = new Set(rooms.map((r) => r.id));
  groups.push({ id: OTHER, name: otherLabel, devices: sorted.filter((d) => !d.roomId || !known.has(d.roomId)) });
  return groups.filter((g) => g.devices.length);
}

/** "6 devices online · 2 lights on · 22.4° Bedroom" */
export function useSummary(devices: DeviceDTO[], rooms: Room[], t: Translate): { text: string; indoor?: string } {
  const online = devices.filter((d) => d.availability === 'online').length;
  const offline = devices.filter((d) => d.availability === 'offline').length;
  const lightsOn = devices.filter((d) => deviceKind(d) === 'light' && d.availability !== 'offline' && lightState(d)?.on).length;
  const parts = [t('home.summary.online', { n: online })];
  parts.push(lightsOn ? t('home.summary.lights', { n: lightsOn }) : t('home.summary.noLights'));
  let indoor: string | undefined;
  for (const d of sortDevices(devices)) {
    const temp = readings(d).find((r) => r.capability === 'temperatureMeasurement');
    if (!temp || d.availability === 'offline') continue;
    const room = rooms.find((r) => r.id === d.roomId)?.name;
    indoor = `${round1(temp.value)}°`;
    parts.push(room ? `${indoor} ${room}` : indoor);
    break;
  }
  if (offline) parts.push(t('home.summary.offline', { n: offline }));
  return { text: parts.join(' · '), indoor };
}

function greeting(t: Translate, now: Date): string {
  const h = now.getHours();
  return h >= 5 && h < 12 ? t('home.morning') : h >= 12 && h < 18 ? t('home.afternoon') : t('home.evening');
}

export function useNow(intervalMs = 10_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function HomePage() {
  const t = useT();
  const lang = useLang();
  const { devices: byId, rooms, ready } = useLive();
  const devices = useMemo(() => Object.values(byId), [byId]);
  const [room, setRoom] = useState<string>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [view, setViewState] = useState<HomeView>(() => readView(VIEW_KEY));
  const setView = useCallback((v: HomeView) => {
    setViewState(v);
    writeView(VIEW_KEY, v);
  }, []);
  const now = useNow();
  const canAdmin = useCan('admin');
  const summary = useSummary(devices, rooms, t);
  const groups = groupByRoom(devices, rooms, t('home.other'));
  const visible = room === 'all' ? groups : groups.filter((g) => g.id === room);

  useEffect(() => {
    if (room !== 'all' && !groups.some((g) => g.id === room)) setRoom('all');
  }, [room, groups]);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-muted">{formatDateLine(now, lang)}</div>
          <h1 className="mt-1 mb-0 text-[26px] leading-[1.15] font-extrabold tracking-[-0.025em] md:text-[34px]">{greeting(t, now)}</h1>
          <div className="mt-1.5 text-sm text-muted">{ready ? summary.text : t('common.loading')}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={t('home.view.label')}
            value={view}
            onChange={setView}
            options={[
              { value: 'cards', label: t('home.view.cards'), icon: 'grid' },
              { value: 'plan', label: t('home.view.plan'), icon: 'map' },
              { value: '3d', label: t('home.view.3d'), icon: 'box' },
            ]}
          />
          <a href={href('wall')} aria-label={t('nav.wall')} title={t('nav.wall')} className="grid size-11 place-items-center rounded-[13px] bg-chip text-ink! md:hidden">
            <Icon name="tablet" size={17} />
          </a>
          <Button variant="amber" icon="plus" onClick={() => openAddDevice()} className="min-h-11 max-sm:size-11 max-sm:p-0" aria-label={t('add.cta')} title={t('add.cta')}>
            <span className="max-sm:hidden">{t('add.cta')}</span>
          </Button>
        </div>
      </div>

      {ready && view === 'cards' && groups.length > 1 && (
        <div className="lv-scroll-x -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 md:mx-0 md:px-0" role="tablist" aria-label={t('nav.rooms')}>
          {[{ id: 'all', name: t('home.all') }, ...groups].map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={room === g.id}
              onClick={() => setRoom(g.id)}
              className={cx(
                'min-h-9 shrink-0 rounded-full border-0 px-3.5 py-2 text-[13px] font-bold transition-colors duration-base',
                room === g.id ? 'bg-ink text-bg' : 'bg-chip text-ink hover:bg-line',
              )}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {view !== 'cards' && ready ? (
        <HomeSpace view={view} onView={setView} onOpen={setOpen} />
      ) : !ready ? (
        <CardSkeleton />
      ) : devices.length === 0 ? (
        <EmptyState icon="home" title={t('home.empty.title')} body={canAdmin ? t('add.emptyBody') : t('home.empty.body')}>
          <Button variant="amber" icon="plus" onClick={() => openAddDevice()}>
            {t('add.cta')}
          </Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-7">
          {visible.map((g) => (
            <section key={g.id} aria-label={g.name} className="flex flex-col gap-3">
              {room === 'all' && (
                <h2 className="m-0 flex items-baseline gap-2 text-[15px] font-extrabold tracking-[-0.01em]">
                  {g.name}
                  <span className="text-xs font-semibold text-muted">{g.devices.length}</span>
                </h2>
              )}
              <DeviceGrid devices={g.devices} onOpen={setOpen} />
            </section>
          ))}
        </div>
      )}

      {open && <DeviceSheet deviceId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function DeviceGrid({ devices, onOpen, large }: { devices: DeviceDTO[]; onOpen: (id: string) => void; large?: boolean }) {
  return (
    <div className={cx('grid gap-3', large ? 'grid-cols-[repeat(auto-fill,minmax(220px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]')}>
      {devices.map((d) => (
        <DeviceCard key={d.id} device={d} onOpen={() => onOpen(d.id)} large={large} />
      ))}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 md:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-[124px] flex-col justify-between rounded-card border border-line bg-surface p-3.5 shadow-card">
          <div className="size-10 animate-pulse rounded-[13px] bg-chip" />
          <div className="flex flex-col gap-2">
            <div className="h-3 w-3/4 animate-pulse rounded bg-chip" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-chip" />
          </div>
        </div>
      ))}
    </div>
  );
}
