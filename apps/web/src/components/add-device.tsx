import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DeviceDTO } from '@livynq/model';
import { addDevice, chooseMethod, closeAddDevice, fromMethod, useAddDevice } from '../lib/add-device.ts';
import { api, errorMessage, type Onboarding, type OnboardingMethod, type OnboardingMethodId, type PluginInfo } from '../lib/api.ts';
import { describe, roomName } from '../lib/devices.ts';
import { useT, type MessageKey } from '../lib/i18n.ts';
import { live, useLive } from '../lib/live.ts';
import { useCan } from '../lib/session.ts';
import { href } from '../lib/router.ts';
import { HomeAssistantPanel, MatterPanel, MqttPanel, VirtualPanel, ZigbeePanel, EspHomePanel, HuePanel, ShellyPanel, XiaomiPanel, ZWavePanel } from './add-device-methods.tsx';
import { toneStyle } from './device-card.tsx';
import { DeviceSheet } from './device-sheet.tsx';
import { Icon, type IconName } from './icons.tsx';
import { openSheets } from './sheet.tsx';
import { Badge, Button, Dot, ErrorNote, IconButton, Spinner, cx } from './ui.tsx';

/** Mounted once inside the signed-in app. */
export function AddDeviceHost() {
  const { open } = useAddDevice();
  // Signing out (or leaving for wall mode) must not leave the wizard open for next time.
  useEffect(() => closeAddDevice, []);
  return open ? <AddDeviceWizard /> : null;
}

interface MethodMeta {
  id: OnboardingMethodId;
  icon: IconName;
  name: string;
  desc: MessageKey;
  tags?: string;
}

const METHODS: MethodMeta[] = [
  { id: 'matter', icon: 'share', name: 'Matter', desc: 'add.m.matter', tags: 'Apple · Google · Amazon · SmartThings' },
  { id: 'zigbee', icon: 'usb', name: 'Zigbee', desc: 'add.m.zigbee', tags: 'Aqara · IKEA · Hue · Tuya' },
  { id: 'zwave', icon: 'activity', name: 'Z-Wave', desc: 'add.m.zwave', tags: 'Aeotec · Fibaro · Zooz · Inovelli' },
  { id: 'esphome', icon: 'cpu', name: 'ESPHome', desc: 'add.m.esphome' },
  { id: 'xiaomi', icon: 'home', name: '米家 Xiaomi', desc: 'add.m.xiaomi', tags: 'Mi Home · Yeelight · Mijia' },
  { id: 'hue', icon: 'bulb', name: 'Philips Hue', desc: 'add.m.hue', tags: 'Hue Bridge · Friends of Hue' },
  { id: 'shelly', icon: 'zap', name: 'Shelly', desc: 'add.m.shelly', tags: 'Plus · Pro · Gen3 · Gen4' },
  { id: 'mqtt', icon: 'radio', name: 'MQTT', desc: 'add.m.mqtt', tags: 'Zigbee2MQTT · Tasmota · ESPHome' },
  { id: 'homeassistant', icon: 'home', name: 'Home Assistant', desc: 'add.m.ha' },
  { id: 'virtual', icon: 'toggle', name: '', desc: 'add.m.virtual' },
];

export function methodName(id: OnboardingMethodId, t: (k: MessageKey) => string): string {
  return id === 'virtual' ? t('add.virtual.name') : (METHODS.find((m) => m.id === id)?.name ?? id);
}

/** What every method panel receives. */
export interface PanelProps<M extends OnboardingMethod = OnboardingMethod> {
  method: M;
  canAdmin: boolean;
  /** Devices from this method that appeared since the wizard opened (live). */
  added: DeviceDTO[];
  /** Runtime status of this method's plugin (admin tokens only; null when unknown). */
  health: PluginInfo | null;
  /** Re-reads `/plugins` (e.g. after a restart). */
  refreshPlugins: () => Promise<void>;
  /** Re-reads `/onboarding` (after enabling a plugin). */
  reload: () => Promise<void>;
  openDevice: (id: string) => void;
}

function AddDeviceWizard() {
  const t = useT();
  const { method: methodId } = useAddDevice();
  const canAdmin = useCan('admin');
  const { devices } = useLive();
  const [data, setData] = useState<Onboarding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceSheet, setDeviceSheet] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Everything that exists now is "old"; whatever shows up later was just added.
  const baseline = useRef<Set<string>>(new Set(Object.keys(live.get().devices)));

  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);

  const refreshPlugins = useCallback(async () => {
    if (!canAdmin) return;
    try {
      setPlugins(await api.plugins());
    } catch {
      // health is a nice-to-have; the onboarding data still works
    }
  }, [canAdmin]);

  const reload = useCallback(async () => {
    try {
      const [onboarding] = await Promise.all([api.onboarding(), refreshPlugins()]);
      setData(onboarding);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [refreshPlugins]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Plugin health: poll quickly while something is starting, slowly otherwise.
  const settled = !plugins?.some((p) => p.status === 'starting');
  useEffect(() => {
    if (!canAdmin) return;
    const id = setInterval(() => void refreshPlugins(), settled ? 10_000 : 2500);
    return () => clearInterval(id);
  }, [canAdmin, settled, refreshPlugins]);

  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
  }, [methodId]);

  // Escape steps back, then closes; a device sheet opened from here handles its own Escape.
  const sheetOpen = useRef(false);
  sheetOpen.current = deviceSheet !== null;
  useEffect(() => {
    openSheets.set((n) => n + 1);
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || sheetOpen.current) return;
      if (document.querySelector('[role="alertdialog"]')) return;
      const { method } = addDevice.get();
      if (method) chooseMethod(null);
      else closeAddDevice();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      openSheets.set((n) => n - 1);
      previous?.focus?.();
    };
  }, []);

  const method = data?.methods.find((m) => m.id === methodId) ?? null;
  const added = useMemo(
    () =>
      methodId
        ? Object.values(devices)
            .filter((d) => !baseline.current.has(d.id) && fromMethod(d, methodId))
            .sort((a, b) => a.createdAt - b.createdAt)
        : [],
    [devices, methodId],
  );
  const step = !methodId ? 0 : added.length ? 2 : 1;
  const title = methodId ? methodName(methodId, t) : t('add.title');

  return createPortal(
    <div className="fixed inset-0 z-40 flex md:items-center md:justify-center md:p-6">
      <div className="absolute inset-0 animate-fade-in bg-overlay max-md:hidden" onClick={closeAddDevice} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('add.title')}
        tabIndex={-1}
        className="relative flex h-full w-full animate-sheet-up flex-col overflow-hidden bg-bg text-ink outline-none md:h-[min(880px,100%)] md:max-w-[840px] md:rounded-panel md:shadow-sheet"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3 md:px-6 md:pt-4 md:pb-4">
          {methodId ? (
            <IconButton icon="chevronLeft" label={t('add.back')} onClick={() => chooseMethod(null)} />
          ) : (
            <span className="grid size-10 shrink-0 place-items-center rounded-ctl bg-amber text-on-amber" aria-hidden="true">
              <Icon name="plus" size={19} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-lg leading-tight font-extrabold tracking-[-0.015em] md:text-xl">{title}</h2>
            <div className="truncate text-[12.5px] text-muted">{methodId ? t('add.title') : t('add.subtitle')}</div>
          </div>
          <IconButton icon="x" label={t('common.close')} onClick={closeAddDevice} />
        </header>
        <StepBar step={step} />
        <div ref={scroller} className="flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto flex max-w-[680px] flex-col gap-5 px-4 pt-5 pb-[max(28px,env(safe-area-inset-bottom))] md:px-7 md:pt-6">
            {error && (
              <ErrorNote>
                {error}{' '}
                <button type="button" className="border-0 bg-transparent p-0 font-bold text-ink underline" onClick={() => void reload()}>
                  {t('common.retry')}
                </button>
              </ErrorNote>
            )}
            {!data && !error ? (
              <div className="grid place-items-center py-16 text-muted">
                <Spinner size={22} />
              </div>
            ) : !methodId ? (
              data && <Chooser data={data} canAdmin={canAdmin} plugins={plugins} />
            ) : method ? (
              <MethodPanel
                method={method}
                canAdmin={canAdmin}
                added={added}
                health={'plugin' in method ? (plugins?.find((p) => p.id === method.plugin) ?? null) : null}
                refreshPlugins={refreshPlugins}
                reload={reload}
                openDevice={setDeviceSheet}
              />
            ) : null}
          </div>
        </div>
      </div>
      {deviceSheet && <DeviceSheet deviceId={deviceSheet} onClose={() => setDeviceSheet(null)} />}
    </div>,
    document.body,
  );
}

function StepBar({ step }: { step: number }) {
  const t = useT();
  const steps: MessageKey[] = ['add.step.choose', 'add.step.connect', 'add.step.room'];
  return (
    <div className="shrink-0 border-b border-line bg-surface px-4 pt-1 pb-3 md:px-6">
      <ol className="m-0 mx-auto grid max-w-[680px] list-none grid-cols-3 gap-2 p-0" aria-label={t('add.steps')}>
        {steps.map((s, i) => (
          <li key={s} className="flex flex-col gap-1.5" aria-current={i === step ? 'step' : undefined}>
            <div className={cx('h-1 rounded-full transition-colors duration-slow', i <= step ? 'bg-amber' : 'bg-chip')} />
            <div className={cx('flex items-center gap-1.5 text-[12px] font-bold', i === step ? 'text-ink' : 'text-muted')}>
              <span className="font-mono text-[10.5px]">0{i + 1}</span>
              <span className="truncate">{t(s)}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- step 1: choose how

type MethodStatus = 'enabled' | 'disabled' | 'info' | 'starting' | 'error';

function statusOf(m: OnboardingMethod | undefined, plugins: PluginInfo[] | null): MethodStatus {
  if (!m) return 'disabled';
  if (m.id === 'mqtt') return m.enabled ? 'enabled' : 'info';
  if (!m.enabled) return 'disabled';
  const p = plugins?.find((x) => x.id === m.plugin);
  return !p || p.status === 'running' ? 'enabled' : p.status === 'starting' ? 'starting' : 'error';
}

function Chooser({ data, canAdmin, plugins }: { data: Onboarding; canAdmin: boolean; plugins: PluginInfo[] | null }) {
  const t = useT();
  return (
    <>
      {!canAdmin && <Note icon="lock">{t('add.readOnly')}</Note>}
      <div className="grid gap-3 sm:grid-cols-2">
        {METHODS.map((m) => {
          const info = data.methods.find((x) => x.id === m.id);
          const status = statusOf(info, plugins);
          const recommended = m.id === 'matter';
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => chooseMethod(m.id)}
              className={cx(
                'group flex items-start gap-3.5 rounded-card border-[1.5px] bg-surface p-4 text-left text-ink shadow-card transition-[border-color,transform] duration-base hover:border-amber active:scale-[0.99]',
                recommended ? 'border-amber/60 sm:col-span-2' : 'border-line',
              )}
            >
              <span className={cx('grid size-11 shrink-0 place-items-center rounded-tile', status === 'enabled' ? 'bg-amber-soft text-amber-ink' : 'bg-chip text-ink')}>
                <Icon name={m.icon} size={20} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[15.5px] font-extrabold tracking-[-0.01em]">{m.id === 'virtual' ? t('add.virtual.name') : m.name}</span>
                  {recommended && <span className="rounded-full bg-amber px-2 py-0.5 text-[10.5px] font-extrabold text-on-amber">{t('add.recommended')}</span>}
                  <StatusPill status={status} />
                </span>
                <span className="text-[13px] leading-snug text-pretty text-muted">{t(m.desc)}</span>
                {m.tags && <span className="mt-0.5 text-[11.5px] font-semibold text-muted/80">{m.tags}</span>}
              </span>
              <Icon name="chevronRight" size={18} className="mt-3 shrink-0 text-muted transition-transform duration-base group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
      <p className="m-0 text-center text-[12.5px] text-pretty text-muted">{t('add.chooserFoot')}</p>
    </>
  );
}

function StatusPill({ status }: { status: MethodStatus }) {
  const t = useT();
  if (status === 'error')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-alert-soft px-2 py-0.5 text-[10.5px] font-bold text-alert">
        <Dot tone="alert" />
        {t('add.status.error')}
      </span>
    );
  if (status === 'starting') return <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-bold">{t('add.status.starting')}</span>;
  if (status === 'enabled')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2 py-0.5 text-[10.5px] font-bold">
        <Dot tone="ok" />
        {t('add.enabled')}
      </span>
    );
  return <span className="rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-bold text-muted">{status === 'info' ? t('add.automatic') : t('add.notEnabled')}</span>;
}

// ---------------------------------------------------------------- step 2: per method

function MethodPanel(props: PanelProps) {
  const { method } = props;
  switch (method.id) {
    case 'matter':
      return <MatterPanel {...props} method={method} />;
    case 'zigbee':
      return <ZigbeePanel {...props} method={method} />;
    case 'zwave':
      return <ZWavePanel {...props} method={method} />;
    case 'esphome':
      return <EspHomePanel {...props} method={method} />;
    case 'shelly':
      return <ShellyPanel {...props} method={method} />;
    case 'hue':
      return <HuePanel {...props} method={method} />;
    case 'xiaomi':
      return <XiaomiPanel {...props} method={method} />;
    case 'homeassistant':
      return <HomeAssistantPanel {...props} method={method} />;
    case 'virtual':
      return <VirtualPanel {...props} method={method} />;
    case 'mqtt':
      return <MqttPanel {...props} method={method} />;
  }
}

// ---------------------------------------------------------------- shared pieces

export function Note({ icon = 'info', tone = 'chip', children }: { icon?: IconName; tone?: 'chip' | 'amber' | 'ok'; children: ReactNode }) {
  const tones = { chip: 'bg-chip', amber: 'bg-amber-soft', ok: 'bg-ok-soft' };
  return (
    <div className={cx('flex items-start gap-2.5 rounded-[14px] px-3.5 py-3 text-[13px] leading-relaxed text-pretty', tones[tone])}>
      <Icon name={icon} size={17} className={cx('mt-0.5 shrink-0', tone === 'amber' ? 'text-amber-ink' : tone === 'ok' ? 'text-ok' : 'text-muted')} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Panel({ title, icon, aside, children, className }: { title?: ReactNode; icon?: IconName; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('flex flex-col gap-4 rounded-card border border-line bg-surface p-4 shadow-card md:p-5', className)}>
      {title && (
        <div className="flex items-center justify-between gap-3">
          <h3 className="m-0 flex min-w-0 items-center gap-2 text-[15.5px] font-extrabold tracking-[-0.01em]">
            {icon && <Icon name={icon} size={17} className="shrink-0 text-amber-ink" />}
            <span className="min-w-0">{title}</span>
          </h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** Numbered how-to list in the amber-dot style used on the ecosystems page. */
export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
      {items.map((s, i) => (
        <li key={i} className="flex items-start gap-2.5 text-[13.5px] leading-snug">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-soft font-mono text-[11px] font-bold text-amber-ink">{i + 1}</span>
          <span className="min-w-0 pt-[3px] text-pretty">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Shown while a plugin is disabled: what it is, the config it needs (children) and "Enable".
 * `config()` returns the config to send, or null when the form is incomplete.
 */
export function EnablePlugin({
  method,
  canAdmin,
  intro,
  config,
  children,
  onEnabled,
}: {
  method: Extract<OnboardingMethod, { module: string }>;
  canAdmin: boolean;
  intro: ReactNode;
  config?: () => Record<string, unknown> | null;
  children?: ReactNode;
  onEnabled: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cfg = config?.();
  const ready = !config || cfg !== null;

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.enablePlugin(method.module, cfg ?? undefined);
      await onEnabled();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('add.enable.title', { name: methodName(method.id, t) })} icon="power" aside={<Badge>{t('add.notEnabled')}</Badge>}>
      <div className="text-[13.5px] leading-relaxed text-pretty text-muted">{intro}</div>
      {canAdmin ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void enable();
          }}
        >
          {children}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="amber" icon="power" busy={busy} disabled={!ready}>
              {busy ? t('add.enable.busy') : t('add.enable.cta')}
            </Button>
            <span className="text-xs text-muted">{t('add.enable.persist')}</span>
          </div>
        </form>
      ) : (
        <Note icon="lock">{t('add.enable.adminOnly')}</Note>
      )}
    </Panel>
  );
}

/** Plugin health for an enabled integration (admin only): starting / crashed with its last error. */
export function PluginHealth({ info, refresh }: { info: PluginInfo | null; refresh: () => Promise<void> }) {
  const t = useT();
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  if (!info || (info.status === 'running' && !info.lastError)) return null;
  if (info.status === 'starting')
    return (
      <Note icon="hourglass" tone="amber">
        <span className="flex items-center gap-2">
          {t('add.health.starting')} <Spinner size={13} />
        </span>
      </Note>
    );
  return (
    <ErrorNote>
      <span className="flex flex-col gap-2">
        <span className="font-bold">{info.status === 'disabled' ? t('add.health.disabled') : info.status === 'crashed' ? t('add.health.crashed') : t('add.health.error')}</span>
        {info.lastError && <span className="font-mono text-[12px] break-words">{info.lastError}</span>}
        {restartError && <span className="text-[12.5px]">{restartError}</span>}
        <span className="text-[12.5px] text-pretty">
          {t('add.health.fix')}{' '}
          <a href={href('plugins')} onClick={closeAddDevice} className="font-bold text-ink underline">
            {t('plugins.manageLink')}
          </a>
        </span>
        {info.isolation === 'process' && (
          <span>
            <Button
              size="sm"
              icon="rotateCcw"
              busy={restarting}
              onClick={async () => {
                setRestarting(true);
                setRestartError(null);
                try {
                  await api.restartPlugin(info.id);
                } catch (e) {
                  setRestartError(errorMessage(e));
                } finally {
                  await refresh();
                  setRestarting(false);
                }
              }}
            >
              {t('add.health.restart')}
            </Button>
          </span>
        )}
      </span>
    </ErrorNote>
  );
}

/** Devices that just appeared, each with a shortcut to name it and put it in a room. */
export function AddedDevices({
  devices,
  openDevice,
  waiting,
  title,
  limit = 12,
}: {
  devices: DeviceDTO[];
  openDevice: (id: string) => void;
  waiting?: ReactNode;
  title?: string;
  limit?: number;
}) {
  const t = useT();
  const { rooms } = useLive();
  if (!devices.length && !waiting) return null;
  const shown = devices.slice(0, limit);
  return (
    <Panel
      title={title ?? (devices.length ? t('add.added.title', { n: devices.length }) : t('add.added.waitingTitle'))}
      icon={devices.length ? 'circleCheck' : 'loader'}
      aside={devices.length && !title ? <Badge tone="ok">{t('add.added.new')}</Badge> : undefined}
    >
      {!devices.length && <div className="flex items-center gap-2.5 text-[13.5px] text-muted">{waiting}</div>}
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {shown.map((d) => {
            const v = describe(d, t);
            const style = toneStyle(v);
            const room = roomName(d, rooms);
            return (
              <li key={d.id} className="flex animate-fade-in items-center gap-3 rounded-[15px] bg-surface2 p-2.5 pr-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-[11px]" style={style.icon}>
                  <Icon name={v.icon} size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-bold">{d.name}</span>
                  <span className="block truncate text-[12px] text-muted">{[room ?? t('add.added.noRoom'), d.info.manufacturer, d.info.model].filter(Boolean).join(' · ')}</span>
                </span>
                <Button size="sm" icon={room ? 'pencil' : 'layers'} onClick={() => openDevice(d.id)}>
                  <span className="max-sm:sr-only">{room ? t('add.added.edit') : t('add.added.room')}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {devices.length > limit && <div className="text-xs text-muted">{t('add.added.more', { n: devices.length - limit })}</div>}
      {devices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button variant="primary" icon="layers" onClick={() => openDevice(devices.find((d) => !d.roomId)?.id ?? devices[0]!.id)}>
            {t('add.added.next')}
          </Button>
          <Button variant="ghost" onClick={closeAddDevice}>
            {t('add.done')}
          </Button>
        </div>
      )}
    </Panel>
  );
}
