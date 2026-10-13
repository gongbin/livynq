import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Level } from '@livynq/model';
import { api, errorMessage } from '../../lib/api.ts';
import { ALL_LEVELS, autoLayout, placedOn, readLevelChoice, roomsOn, writeLevelChoice } from '../../lib/floorplan.ts';
import { useLang, useT, type Translate } from '../../lib/i18n.ts';
import { live, upsertLevel, upsertRoom, useLive } from '../../lib/live.ts';
import { useResolvedTheme } from '../../lib/prefs.ts';
import { useCan } from '../../lib/session.ts';
import { Icon } from '../icons.tsx';
import { toast } from '../toast.tsx';
import { Button, cx } from '../ui.tsx';
import type { MarkerSize } from './device-marker.tsx';
import { PlanEditor } from './plan-editor.tsx';
import { PlanLegend, PlanView } from './plan-view.tsx';

/** The whole 3D module (three, R3F, drei) is split into its own chunk and only fetched here. */
const Scene3D = lazy(() => import('./scene3d.tsx'));


const ZH_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export function levelName(t: Translate, n: number, lang: 'zh' | 'en'): string {
  return lang === 'zh' && n <= 10 ? `${ZH_NUM[n - 1]}楼` : t('plan.levelN', { n });
}

let webgl: boolean | undefined;
export function hasWebGL(): boolean {
  if (webgl !== undefined) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Level pills (top-left of the plan). */
export function LevelTabs({ levels, value, onChange, allowAll, className }: { levels: Level[]; value: string; onChange: (id: string) => void; allowAll?: boolean; className?: string }) {
  const t = useT();
  const items = allowAll && levels.length > 1 ? [...levels.map((l) => ({ id: l.id, name: l.name })), { id: ALL_LEVELS, name: t('plan.allLevels') }] : levels.map((l) => ({ id: l.id, name: l.name }));
  if (items.length < 2) return null;
  return (
    <div role="tablist" aria-label={t('plan.levels')} className={cx('flex gap-[3px] rounded-[13px] border border-line bg-surface/90 p-1 shadow-card backdrop-blur', className)}>
      {items.map((l) => (
        <button
          key={l.id}
          type="button"
          role="tab"
          aria-selected={value === l.id}
          onClick={() => onChange(l.id)}
          className={cx('min-h-8 rounded-[10px] border-0 px-3 py-1.5 text-[12.5px] font-bold whitespace-nowrap transition-colors duration-base', value === l.id ? 'bg-ink text-bg' : 'bg-transparent text-muted hover:text-ink')}
        >
          {l.name}
        </button>
      ))}
    </div>
  );
}

/** Selected level (remembered per browser); falls back to the first one. */
export function useLevelChoice(levels: Level[] | null, key: string, allowAll: boolean): [string, (id: string) => void] {
  const [id, setId] = useState<string>(() => readLevelChoice(key) ?? '');
  const valid = levels && (levels.some((l) => l.id === id) || (allowAll && id === ALL_LEVELS && levels.length > 1));
  const effective = valid ? id : (levels?.[0]?.id ?? '');
  const set = (v: string) => {
    setId(v);
    writeLevelChoice(key, v);
  };
  return [effective, set];
}

/** Creates the first floor and (optionally) a rectangle per room with its devices, so nobody starts from a blank page. */
export async function runAutoLayout(t: Translate, lang: 'zh' | 'en', levelId?: string): Promise<string | undefined> {
  const { rooms, devices, levels } = live.get();
  let id = levelId;
  if (!id) {
    const level = await api.createLevel(levelName(t, (levels?.length ?? 0) + 1, lang));
    upsertLevel(level);
    id = level.id;
  }
  const targets = rooms.filter((r) => !r.polygon);
  if (!targets.length) {
    toast(rooms.length ? t('plan.auto.nothing') : t('plan.auto.noRooms'), 'info');
    return id;
  }
  const existing = roomsOn(rooms, id).flatMap((r) => r.polygon!);
  const originY = existing.length ? Math.ceil(Math.max(...existing.map((p) => p[1]))) + 1 : 0;
  const layout = autoLayout(targets, Object.values(devices), originY);
  for (const r of layout.rooms) upsertRoom(await api.updateRoom(r.id, { levelId: id, polygon: r.polygon }));
  await Promise.all(layout.placements.map((p) => api.placeDevice(p.deviceId, { levelId: id, x: p.x, y: p.y })));
  toast(t('plan.auto.done', { rooms: layout.rooms.length, devices: layout.placements.length }));
  return id;
}

function EmptyPlan({ onEdit }: { onEdit: (levelId: string) => void }) {
  const t = useT();
  const { rooms } = useLive();
  const lang = useLang();
  const canAdmin = useCan('admin');
  const [busy, setBusy] = useState<'create' | 'auto' | null>(null);
  const create = async () => {
    setBusy('create');
    try {
      const level = await api.createLevel(levelName(t, 1, lang));
      upsertLevel(level);
      onEdit(level.id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const auto = async () => {
    setBusy('auto');
    try {
      const id = await runAutoLayout(t, lang);
      if (id) onEdit(id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="lv-plan-bg flex min-h-[420px] flex-col items-center justify-center gap-4 rounded-[18px] px-6 py-12 text-center" style={{ backgroundSize: '28px 28px' }}>
      <span className="grid size-16 place-items-center rounded-tile bg-amber-soft text-amber-ink shadow-card">
        <Icon name="map" size={28} />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <div className="text-lg font-extrabold tracking-[-0.01em]">{t('plan.empty.title')}</div>
        <p className="m-0 text-sm leading-relaxed text-pretty text-muted">{canAdmin ? t('plan.empty.body') : t('plan.empty.readOnly')}</p>
      </div>
      {canAdmin && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="amber" icon="pencil" busy={busy === 'create'} disabled={!!busy} onClick={() => void create()}>
            {t('plan.empty.create')}
          </Button>
          {rooms.length > 0 && (
            <Button icon="wand" busy={busy === 'auto'} disabled={!!busy} onClick={() => void auto()} title={t('plan.auto.hint')}>
              {t('plan.auto.cta')}
            </Button>
          )}
        </div>
      )}
      {canAdmin && rooms.length > 0 && <p className="m-0 max-w-sm text-xs text-muted">{t('plan.auto.hint')}</p>}
    </div>
  );
}

/** Catches a failed lazy chunk or WebGL setup and falls back to 2D. */
class SceneBoundary extends Component<{ fallback: (err: unknown) => ReactNode; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

function SceneSkeleton() {
  const t = useT();
  return (
    <div className="lv-plan-bg absolute inset-0 grid place-items-center" style={{ backgroundSize: '28px 28px' }} aria-busy="true">
      <div className="flex flex-col items-center gap-3">
        <div className="relative size-24 animate-pulse" style={{ transform: 'rotateX(56deg) rotateZ(-38deg)', transformStyle: 'preserve-3d' }} aria-hidden="true">
          <div className="absolute inset-0 rounded-md border-[3px] border-wall bg-floor" />
          <div className="absolute inset-y-0 left-1/2 w-[3px] bg-wall" />
        </div>
        <span className="text-[13px] font-semibold text-muted">{t('plan.loading3d')}</span>
      </div>
    </div>
  );
}

/**
 * Floor plan / 3D home for the home page and the wall. Owns level choice, the empty state and the
 * editor (admins). `view` picks 2D or 3D; `onView` lets 3D fall back to 2D.
 */
export function HomeSpace({ view, onView, onOpen, wall }: { view: 'plan' | '3d'; onView: (v: 'plan' | '3d') => void; onOpen: (id: string) => void; wall?: boolean }) {
  const t = useT();
  const theme = useResolvedTheme();
  const { levels, rooms, devices: byId } = useLive();
  const devices = useMemo(() => Object.values(byId), [byId]);
  const canAdmin = useCan('admin');
  const [levelId, setLevelId] = useLevelChoice(levels, view === '3d' ? 'livynq.plan.level3d' : 'livynq.plan.level', view === '3d');
  const [editing, setEditing] = useState<string | null>(null);
  const noGl = view === '3d' && !hasWebGL();

  useEffect(() => {
    if (!noGl) return;
    toast(t('plan.noWebgl'), 'info');
    onView('plan');
  }, [noGl, onView, t]);

  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const m = matchMedia('(max-width: 640px)');
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);

  if (levels === null) return <div className="h-[min(64dvh,640px)] animate-pulse rounded-panel border border-line bg-surface shadow-card" aria-busy="true" />;

  if (editing && canAdmin && !wall) {
    return (
      <PlanEditor
        levelId={levels.some((l) => l.id === editing) ? editing : (levels[0]?.id ?? '')}
        onLevel={(id) => {
          setEditing(id);
          setLevelId(id);
        }}
        onDone={() => setEditing(null)}
      />
    );
  }

  const level = levels.find((l) => l.id === levelId);
  const markerSize: MarkerSize = wall ? 'lg' : phone ? 'sm' : 'md';
  const empty = level && view === 'plan' && roomsOn(rooms, level.id).length === 0 && placedOn(devices, level.id).length === 0 && !level.background;

  return (
    <div className={cx('rounded-panel border border-line bg-surface shadow-card', wall ? 'p-3 md:p-4' : 'p-3 md:p-5')}>
      {!levels.length ? (
        <EmptyPlan onEdit={(id) => setEditing(id)} />
      ) : (
        <div className={cx('relative overflow-hidden rounded-[18px]', wall ? 'h-[calc(100dvh-300px)] min-h-[440px]' : 'h-[min(56dvh,520px)] min-h-[360px] sm:h-[min(66dvh,680px)] sm:min-h-[380px]')}>
          {view === '3d' ? (
            noGl ? null : (
              <SceneBoundary
                fallback={(err) => (
                  <div className="absolute inset-0 grid place-items-center p-6 text-center">
                    <div className="flex max-w-sm flex-col items-center gap-3">
                      <Icon name="box" size={28} className="text-muted" />
                      <div className="font-extrabold">{t('plan.3dFailed')}</div>
                      <div className="text-xs text-muted">{errorMessage(err)}</div>
                      <Button icon="map" onClick={() => onView('plan')}>
                        {t('plan.switch2d')}
                      </Button>
                    </div>
                  </div>
                )}
              >
                <Suspense fallback={<SceneSkeleton />}>
                  <Scene3D levels={levels} levelId={levelId} rooms={rooms} devices={devices} dark={theme === 'dark'} onOpen={onOpen} large={wall} />
                </Suspense>
              </SceneBoundary>
            )
          ) : empty ? (
            <EmptyLevel level={level} onEdit={() => setEditing(level.id)} />
          ) : level ? (
            <PlanView level={level} rooms={rooms} devices={devices} onOpen={onOpen} markerSize={markerSize} large={wall} />
          ) : null}
          <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
            <LevelTabs levels={levels} value={levelId} onChange={setLevelId} allowAll={view === '3d'} className="pointer-events-auto" />
            <span />
            {canAdmin && !wall && (
              <Button
                size="sm"
                icon="pencil"
                className="pointer-events-auto border border-line bg-surface! shadow-card hover:bg-chip!"
                onClick={() => {
                  if (view === '3d') onView('plan');
                  setEditing(level?.id ?? levels[0]!.id);
                }}
              >
                {t('plan.edit')}
              </Button>
            )}
          </div>
        </div>
      )}
      {levels.length > 0 && <PlanLegend note={view === '3d' ? t('plan.hint3d') : t('plan.hint')} />}
    </div>
  );
}

function EmptyLevel({ level, onEdit }: { level: Level; onEdit: () => void }) {
  const t = useT();
  const canAdmin = useCan('admin');
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const { rooms } = useLive();
  return (
    <div className="lv-plan-bg absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ backgroundSize: '28px 28px' }}>
      <span className="grid size-14 place-items-center rounded-tile bg-chip text-muted">
        <Icon name="square" size={24} />
      </span>
      <div className="text-base font-extrabold">{t('plan.emptyLevel.title', { name: level.name })}</div>
      <p className="m-0 max-w-sm text-sm text-muted">{canAdmin ? t('plan.emptyLevel.body') : t('plan.empty.readOnly')}</p>
      {canAdmin && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="amber" icon="pencil" onClick={onEdit}>
            {t('plan.edit')}
          </Button>
          {rooms.some((r) => !r.polygon) && (
            <Button
              icon="wand"
              busy={busy}
              onClick={() => {
                setBusy(true);
                runAutoLayout(t, lang, level.id)
                  .catch((e: unknown) => toast(errorMessage(e), 'error'))
                  .finally(() => setBusy(false));
              }}
            >
              {t('plan.auto.cta')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
