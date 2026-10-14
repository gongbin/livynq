import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { renderSVG } from 'uqr';
import {
  canScanQr,
  classifyCommissionError,
  createQrDetector,
  dskRest,
  isZwaveQr,
  formatPairingCode,
  isPairingCodeComplete,
  slugId,
  type CommissionError,
} from '../lib/add-device.ts';
import { ApiError, api, errorMessage, type OnboardingMethod } from '../lib/api.ts';
import { useT, type MessageKey } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { AddedDevices, EnablePlugin, Note, Panel, PluginHealth, Steps, type PanelProps } from './add-device.tsx';
import { Icon } from './icons.tsx';
import { confirmDialog } from './dialog.tsx';
import { toast } from './toast.tsx';
import { Badge, Button, CopyButton, Dot, ErrorNote, SelectField, Spinner, Switch, TextField, cx } from './ui.tsx';

type PluginMethod = Extract<OnboardingMethod, { module: string }>;
type MqttMethod = Extract<OnboardingMethod, { id: 'mqtt' }>;

function useTick(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

function Advanced({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group rounded-ctl border border-line px-3.5 py-2.5 [&[open]]:pb-3.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[13px] font-bold text-muted select-none [&::-webkit-details-marker]:hidden">
        {label}
        <Icon name="chevronDown" size={16} className="transition-transform duration-base group-open:rotate-180" />
      </summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-ctl bg-surface2">
      <div className="flex items-center justify-between gap-2 border-b border-line py-1.5 pr-1.5 pl-3.5">
        <span className="truncate text-[12px] font-bold text-muted">{label ?? 'YAML'}</span>
        <CopyButton text={code} label={t('common.copy')} copiedLabel={t('common.copied')} variant="ghost" size="sm" />
      </div>
      <pre className="m-0 overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed whitespace-pre">{code}</pre>
    </div>
  );
}

// ================================================================ Matter

type MatterPhase = { kind: 'idle' } | { kind: 'running'; since: number } | { kind: 'done'; nodeId: string } | { kind: 'error'; error: CommissionError; message: string };

const MATTER_STEPS: { at: number; key: MessageKey }[] = [
  { at: 0, key: 'add.matter.step.discover' },
  { at: 6, key: 'add.matter.step.contact' },
  { at: 15, key: 'add.matter.step.credentials' },
  { at: 30, key: 'add.matter.step.network' },
];

export function MatterPanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  const [code, setCode] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('');
  const [phase, setPhase] = useState<MatterPhase>({ kind: 'idle' });
  const [scanning, setScanning] = useState(false);
  const [scanSupported, setScanSupported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void canScanQr().then(setScanSupported);
  }, []);

  if (!method.enabled)
    return (
      <>
        <MatterIntro />
        <EnablePlugin method={method} canAdmin={canAdmin} intro={t('add.matter.enableIntro')} onEnabled={reload} />
      </>
    );

  const complete = isPairingCodeComplete(code);
  const commission = async () => {
    setPhase({ kind: 'running', since: Date.now() });
    try {
      const params: Record<string, unknown> = { code };
      if (ip.trim()) params.ip = ip.trim();
      if (ip.trim() && port.trim()) params.port = Number(port);
      const res = await api.pluginAction<{ nodeId: string }>('matter', 'commission', params);
      setPhase({ kind: 'done', nodeId: res.nodeId });
    } catch (e) {
      const message = errorMessage(e);
      setPhase({ kind: 'error', error: classifyCommissionError(message, e instanceof ApiError ? e.code : undefined), message });
    }
  };

  const running = !health || health.status === 'running';
  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {!running && phase.kind !== 'running' ? (
        <MatterIntro />
      ) : phase.kind === 'running' ? (
        <Commissioning since={phase.since} />
      ) : phase.kind === 'done' ? (
        <>
          <Note icon="circleCheck" tone="ok">
            <div className="font-bold">{t('add.matter.done')}</div>
            <div className="text-muted">{t('add.matter.doneBody', { node: phase.nodeId })}</div>
          </Note>
          <AddedDevices
            devices={added}
            openDevice={openDevice}
            waiting={
              <>
                <Spinner size={15} /> {t('add.matter.waitingDevices')}
              </>
            }
          />
          <div>
            <Button
              icon="plus"
              onClick={() => {
                setCode('');
                setPhase({ kind: 'idle' });
              }}
            >
              {t('add.matter.another')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <MatterIntro />
          {phase.kind === 'error' && <CommissionFailed error={phase.error} message={phase.message} onRetry={() => void commission()} canRetry={complete && phase.error !== 'code'} />}
          <Panel title={t('add.matter.codeTitle')} icon="key">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (complete && canAdmin) void commission();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="lv-matter-code" className="text-[13px] font-bold">
                  {t('add.matter.codeLabel')}
                </label>
                <div className="flex gap-2">
                  <input
                    id="lv-matter-code"
                    ref={inputRef}
                    value={code}
                    onChange={(e) => {
                      setCode(formatPairingCode(e.target.value));
                      if (phase.kind === 'error') setPhase({ kind: 'idle' });
                    }}
                    inputMode={/^[a-z]/i.test(code) ? 'text' : 'numeric'}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="1234-567-8901"
                    disabled={!canAdmin}
                    aria-describedby="lv-matter-code-hint"
                    className="min-h-14 min-w-0 flex-1 rounded-ctl border border-line bg-surface px-4 font-mono text-[20px] font-bold tracking-[0.06em] text-ink outline-none placeholder:font-semibold placeholder:text-muted/60 focus:border-amber-ink disabled:opacity-60"
                  />
                  {scanSupported && canAdmin && (
                    <Button className="min-h-14 shrink-0" icon="scanQr" onClick={() => setScanning(true)}>
                      <span className="max-sm:sr-only">{t('add.matter.scan')}</span>
                    </Button>
                  )}
                </div>
                <div id="lv-matter-code-hint" className="text-xs text-muted">
                  {t('add.matter.codeHint')}
                </div>
              </div>
              <Advanced label={t('add.matter.advanced')}>
                <p className="m-0 text-xs leading-relaxed text-muted">{t('add.matter.advancedHint')}</p>
                <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
                  <TextField label={t('add.matter.ip')} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50" inputMode="decimal" disabled={!canAdmin} />
                  <TextField label={t('add.matter.port')} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="5540" inputMode="numeric" disabled={!canAdmin || !ip.trim()} />
                </div>
              </Advanced>
              {canAdmin ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" variant="amber" icon="plus" disabled={!complete}>
                    {t('add.matter.submit')}
                  </Button>
                  {!complete && code && <span className="text-xs text-muted">{t('add.matter.incomplete')}</span>}
                </div>
              ) : (
                <Note icon="lock">{t('add.adminOnlyAction')}</Note>
              )}
            </form>
          </Panel>
          <Panel title={t('add.matter.whereTitle')} icon="info">
            <Steps items={[t('add.matter.where1'), t('add.matter.where2'), t('add.matter.where3')]} />
          </Panel>
          {scanning && (
            <QrScanner
              onClose={() => setScanning(false)}
              onResult={(text) => {
                setScanning(false);
                setCode(formatPairingCode(text));
                toast(t('add.matter.scanned'));
              }}
            />
          )}
        </>
      )}
    </>
  );
}

function MatterIntro() {
  const t = useT();
  return (
    <Note icon="home" tone="amber">
      <div className="font-bold">{t('add.matter.appleTitle')}</div>
      <div>{t('add.matter.appleBody')}</div>
    </Note>
  );
}

function Commissioning({ since }: { since: number }) {
  const t = useT();
  const now = useTick(true);
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  const current = MATTER_STEPS.reduce((acc, s, i) => (elapsed >= s.at ? i : acc), 0);
  return (
    <Panel title={t('add.matter.running')} icon="loader" aside={<span className="font-mono text-xs text-muted tabular-nums">{t('add.matter.elapsed', { s: elapsed })}</span>}>
      <div className="lv-indeterminate h-1.5 rounded-full bg-chip" role="progressbar" aria-label={t('add.matter.running')} aria-busy="true" />
      <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-live="polite">
        {MATTER_STEPS.map((s, i) => (
          <li key={s.key} className={cx('flex items-center gap-3 text-[14px]', i > current && 'text-muted')}>
            <span
              className={cx(
                'grid size-7 shrink-0 place-items-center rounded-full',
                i < current ? 'bg-ok-soft text-ok' : i === current ? 'bg-amber-soft text-amber-ink' : 'bg-chip text-muted',
              )}
            >
              {i < current ? <Icon name="check" size={15} /> : i === current ? <Spinner size={14} /> : <span className="font-mono text-[11px] font-bold">{i + 1}</span>}
            </span>
            <span className={cx(i === current && 'font-bold')}>{t(s.key)}</span>
          </li>
        ))}
      </ol>
      {elapsed >= 75 ? (
        <Note icon="hourglass" tone="amber">
          {t('add.matter.slow')}
        </Note>
      ) : (
        <p className="m-0 text-[12.5px] leading-relaxed text-muted">{t('add.matter.runningHint')}</p>
      )}
    </Panel>
  );
}

function CommissionFailed({ error, message, onRetry, canRetry }: { error: CommissionError; message: string; onRetry: () => void; canRetry: boolean }) {
  const t = useT();
  const title: Record<CommissionError, MessageKey> = {
    code: 'add.matter.err.code',
    notFound: 'add.matter.err.notFound',
    network: 'add.matter.err.network',
    timeout: 'add.matter.err.timeout',
    other: 'add.matter.err.other',
  };
  const help: Record<CommissionError, MessageKey> = {
    code: 'add.matter.err.codeHelp',
    notFound: 'add.matter.err.notFoundHelp',
    network: 'add.matter.err.networkHelp',
    timeout: 'add.matter.err.timeoutHelp',
    other: 'add.matter.err.otherHelp',
  };
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-card bg-alert-soft p-4">
      <div className="flex items-start gap-2.5">
        <Icon name="alert" size={19} className="mt-px shrink-0 text-alert" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-[14.5px] font-extrabold">{t(title[error])}</div>
          <div className="text-[13px] leading-relaxed text-pretty">{t(help[error])}</div>
          <div className="mt-1 font-mono text-[11.5px] break-words text-muted">{message}</div>
        </div>
      </div>
      {canRetry && (
        <div className="pl-7">
          <Button size="sm" variant="primary" icon="rotateCcw" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Camera viewfinder using the browser's own BarcodeDetector (no scanning library). */
function QrScanner({ onResult, onClose, accept = /^MT:/i }: { onResult: (text: string) => void; onClose: () => void; accept?: RegExp }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const done = useRef(onResult);
  done.current = onResult;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const detector = createQrDetector();
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stream.getTracks().forEach((tr) => tr.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const scan = async () => {
          if (stopped || !detector) return;
          try {
            const codes = await detector.detect(v);
            const matter = codes.find((c) => accept.test(c.rawValue.trim()));
            if (matter) return done.current(matter.rawValue.trim());
            if (codes.length) setWrong(true);
          } catch {
            // frame not ready yet
          }
          timer = setTimeout(scan, 250);
        };
        void scan();
      } catch (e) {
        setError(e instanceof Error && e.name === 'NotAllowedError' ? t('add.matter.cameraDenied') : errorMessage(e));
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [t]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/85 p-4" role="dialog" aria-modal="true" aria-label={t('add.matter.scan')}>
      <div className="relative aspect-square w-full max-w-[360px] overflow-hidden rounded-panel bg-black">
        <video ref={video} className="size-full object-cover" playsInline muted />
        <div className="pointer-events-none absolute inset-[18%] rounded-card border-[3px] border-amber shadow-[0_0_0_999px_#0006]" aria-hidden="true" />
      </div>
      <div className="max-w-[360px] text-center text-[13.5px] text-white/85">{error ?? (wrong ? t('add.matter.notMatterQr') : t('add.matter.scanHint'))}</div>
      <Button onClick={onClose} icon="x">
        {t('common.cancel')}
      </Button>
    </div>
  );
}

// ================================================================ Zigbee

const ADAPTERS = [
  { value: '', label: 'add.zigbee.adapterAuto' },
  { value: 'zstack', label: 'Z-Stack (TI CC2652 / CC1352 · Sonoff ZBDongle-P · SLZB-06)' },
  { value: 'ember', label: 'Ember (Silicon Labs EFR32 · Sonoff ZBDongle-E · SkyConnect)' },
  { value: 'deconz', label: 'deCONZ (ConBee · RaspBee)' },
  { value: 'zigate', label: 'ZiGate' },
  { value: 'zboss', label: 'ZBOSS (Nordic nRF52)' },
] as const;

const CUSTOM = '__custom';

export function ZigbeePanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  if (!method.enabled) return <ZigbeeEnable method={method} canAdmin={canAdmin} reload={reload} />;
  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {(!health || health.status === 'running') && <ZigbeePairing canAdmin={canAdmin} />}
      <AddedDevices devices={added} openDevice={openDevice} />
      <Panel title={t('add.zigbee.resetTitle')} icon="rotateCcw">
        <Steps items={[t('add.zigbee.reset1'), t('add.zigbee.reset2'), t('add.zigbee.reset3'), t('add.zigbee.reset4')]} />
        <p className="m-0 text-xs leading-relaxed text-muted">{t('add.zigbee.resetFoot')}</p>
      </Panel>
    </>
  );
}

/** USB / serial stick chooser shared by Zigbee and Z-Wave: detected ports, rescan, or a typed path. */
export function useSerialPicker(canAdmin: boolean, labels: { label: MessageKey; empty: MessageKey } = { label: 'add.zigbee.port', empty: 'add.zigbee.noPorts' }): { path: string; field: ReactNode } {
  const t = useT();
  const [ports, setPorts] = useState<{ path: string; label: string }[] | null>(null);
  const [choice, setChoice] = useState('');
  const [custom, setCustom] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!canAdmin) return;
    setLoading(true);
    try {
      const list = await api.serialPorts();
      setPorts(list);
      setChoice((c) => c || list[0]?.path || CUSTOM);
    } catch {
      setPorts([]);
      setChoice(CUSTOM);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmin]);

  const field = (
    <>
      {ports && ports.length === 0 && <Note icon="usb">{t(labels.empty)}</Note>}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <SelectField
            label={t(labels.label)}
            value={choice}
            onChange={setChoice}
            disabled={!ports}
            options={[...(ports ?? []).map((p) => ({ value: p.path, label: p.label === p.path ? p.path : `${p.label} — ${p.path}` })), { value: CUSTOM, label: t('add.zigbee.portCustom') }]}
          />
        </div>
        <Button className="min-h-11" icon="rotateCcw" busy={loading} onClick={() => void load()} aria-label={t('add.zigbee.rescan')} title={t('add.zigbee.rescan')} />
      </div>
      {choice === CUSTOM && (
        <TextField label={t('add.zigbee.portPath')} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="/dev/ttyUSB0" hint={t('add.zigbee.portPathHint')} spellCheck={false} autoCapitalize="off" />
      )}
    </>
  );
  return { path: choice === CUSTOM ? custom.trim() : choice, field };
}

function ZigbeeEnable({ method, canAdmin, reload }: { method: PluginMethod; canAdmin: boolean; reload: () => Promise<void> }) {
  const t = useT();
  const [adapter, setAdapter] = useState('');
  const serial = useSerialPicker(canAdmin);
  return (
    <EnablePlugin
      method={method}
      canAdmin={canAdmin}
      intro={t('add.zigbee.enableIntro')}
      onEnabled={reload}
      config={() => (serial.path ? { serialPort: serial.path, ...(adapter ? { adapter } : {}) } : null)}
    >
      {serial.field}
      <SelectField label={t('add.zigbee.adapter')} value={adapter} onChange={setAdapter} options={ADAPTERS.map((a) => ({ value: a.value, label: a.value ? a.label : t('add.zigbee.adapterAuto') }))} />
    </EnablePlugin>
  );
}

const JOIN_SECONDS = 254;

function ZigbeePairing({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [until, setUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { devices } = useLive();
  const now = useTick(until !== null);
  const remaining = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  // The coordinator's "pairing mode" switch reflects changes made elsewhere (Apple Home, agents, CLI).
  const permitSwitch = devices['zigbee:permit-join']?.state[1]?.onOff?.onOff;

  const refresh = async () => {
    if (!canAdmin) return;
    try {
      const s = await api.pluginAction<{ joining: boolean; until: number | null }>('zigbee', 'status');
      setUntil(s.joining && s.until ? s.until : null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permitSwitch]);
  useEffect(() => {
    if (until && remaining === 0) setUntil(null);
  }, [until, remaining]);

  const run = async (action: 'permitJoin' | 'stopJoin') => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.pluginAction<{ joining: boolean; until: number | null }>('zigbee', action, action === 'permitJoin' ? { seconds: JOIN_SECONDS } : {});
      setUntil(s.joining && s.until ? s.until : null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const joining = until !== null && remaining > 0;
  return (
    <Panel title={t('add.zigbee.pairTitle')} icon="radio" aside={joining ? <Badge tone="amber">{t('add.zigbee.open')}</Badge> : undefined}>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
        <CountdownRing remaining={remaining} total={JOIN_SECONDS} active={joining} />
        <div className="flex min-w-0 flex-1 flex-col gap-3 max-sm:items-center max-sm:text-center">
          <p className="m-0 text-[13.5px] leading-relaxed text-pretty">{joining ? t('add.zigbee.joiningBody') : t('add.zigbee.idleBody')}</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          {canAdmin ? (
            <div className="flex flex-wrap gap-2">
              {joining ? (
                <>
                  <Button variant="primary" icon="stop" busy={busy} onClick={() => void run('stopJoin')}>
                    {t('add.zigbee.stop')}
                  </Button>
                  <Button icon="rotateCcw" disabled={busy} onClick={() => void run('permitJoin')}>
                    {t('add.zigbee.extend')}
                  </Button>
                </>
              ) : (
                <Button variant="amber" icon="play" busy={busy} onClick={() => void run('permitJoin')}>
                  {t('add.zigbee.start')}
                </Button>
              )}
            </div>
          ) : (
            <Note icon="lock">{t('add.adminOnlyAction')}</Note>
          )}
        </div>
      </div>
    </Panel>
  );
}

function CountdownRing({ remaining, total, active }: { remaining: number; total: number; active: boolean }) {
  const t = useT();
  const r = 52;
  const c = 2 * Math.PI * r;
  const frac = active ? remaining / total : 0;
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, '0');
  return (
    <div className="relative grid size-[132px] shrink-0 place-items-center" role="timer" aria-label={active ? t('add.zigbee.remaining', { s: remaining }) : t('add.zigbee.closed')}>
      <svg viewBox="0 0 120 120" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="8" className="stroke-chip" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          className="stroke-amber transition-[stroke-dashoffset] duration-1000 ease-linear"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
        />
      </svg>
      <div className="flex flex-col items-center">
        {active ? (
          <>
            <span className="font-mono text-[26px] leading-none font-bold tabular-nums">
              {mm}:{ss}
            </span>
            <span className="mt-1 text-[11px] font-bold text-muted">{t('add.zigbee.left')}</span>
          </>
        ) : (
          <Icon name="radio" size={30} className="text-muted" />
        )}
      </div>
      {active && <span className="lv-pulse absolute inset-2 rounded-full border-2 border-amber/30" aria-hidden="true" />}
    </div>
  );
}

// ================================================================ ESPHome

interface Discovered {
  host: string;
  address?: string;
  port?: number;
  at: number;
  connected: boolean;
}

export function EspHomePanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  if (!method.enabled) return <EnablePlugin method={method} canAdmin={canAdmin} intro={t('add.esphome.enableIntro')} onEnabled={reload} />;
  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {(!health || health.status === 'running') && (
        <>
          <EspDiscovered canAdmin={canAdmin} />
          <AddedDevices devices={added} openDevice={openDevice} />
          <EspManual canAdmin={canAdmin} />
        </>
      )}
    </>
  );
}

function EspDiscovered({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [list, setList] = useState<Discovered[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await api.pluginAction<Discovered[]>('esphome', 'discovered');
        if (!cancelled) (setList(res), setError(null));
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canAdmin]);

  const connect = async (d: Discovered) => {
    setConnecting(d.host);
    try {
      await api.pluginAction('esphome', 'add', { host: d.address ?? d.host, ...(d.port ? { port: d.port } : {}) });
      toast(t('add.esphome.connecting', { host: d.host }), 'info');
      setList((l) => l?.map((x) => (x.host === d.host ? { ...x, connected: true } : x)) ?? l);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setConnecting(null);
    }
  };

  return (
    <Panel title={t('add.esphome.foundTitle')} icon="network" aside={list && canAdmin ? <Spinner size={14} className="text-muted" /> : undefined}>
      {!canAdmin ? (
        <Note icon="lock">{t('add.adminOnlyAction')}</Note>
      ) : error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !list ? (
        <div className="grid place-items-center py-6 text-muted">
          <Spinner size={18} />
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-5 text-center">
          <span className="grid size-12 place-items-center rounded-tile bg-chip text-muted">
            <Icon name="search" size={20} className="lv-pulse" />
          </span>
          <div className="text-[14px] font-bold">{t('add.esphome.searching')}</div>
          <p className="m-0 max-w-sm text-[12.5px] leading-relaxed text-pretty text-muted">{t('add.esphome.searchingHint')}</p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {list.map((d) => (
            <li key={d.host} className="flex items-center gap-3 rounded-[15px] bg-surface2 p-2.5 pr-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-chip">
                <Icon name="cpu" size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-bold">{d.host.replace(/\.local\.?$/, '')}</span>
                <span className="block truncate font-mono text-[11.5px] text-muted">{[d.address, d.port].filter(Boolean).join(':') || d.host}</span>
              </span>
              {d.connected ? (
                <Badge tone="ok">
                  <Dot tone="ok" />
                  {t('add.esphome.connected')}
                </Badge>
              ) : (
                <Button size="sm" variant="amber" icon="plus" busy={connecting === d.host} onClick={() => void connect(d)}>
                  {t('add.esphome.connect')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function EspManual({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [host, setHost] = useState('');
  const [key, setKey] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.pluginAction('esphome', 'add', { host: host.trim(), ...(port ? { port: Number(port) } : {}), ...(key.trim() ? { encryptionKey: key.trim() } : {}) });
      setNote(t('add.esphome.addedNote', { host: host.trim() }));
      setHost('');
      setKey('');
      setPort('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('add.esphome.manualTitle')} icon="pencil">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (host.trim() && canAdmin) void submit();
        }}
      >
        <TextField label={t('add.esphome.host')} value={host} onChange={(e) => setHost(e.target.value)} placeholder="kitchen-sensor.local · 192.168.1.40" spellCheck={false} autoCapitalize="off" disabled={!canAdmin} />
        <TextField
          label={t('add.esphome.key')}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="base64…="
          hint={t('add.esphome.keyHint')}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="[&_input]:font-mono"
          disabled={!canAdmin}
        />
        <Advanced label={t('add.matter.advanced')}>
          <TextField label={t('add.matter.port')} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="6053" inputMode="numeric" disabled={!canAdmin} />
        </Advanced>
        {error && <ErrorNote>{error}</ErrorNote>}
        {note && (
          <Note icon="circleCheck" tone="ok">
            {note}
          </Note>
        )}
        {canAdmin && (
          <div>
            <Button type="submit" variant="amber" icon="plus" busy={busy} disabled={!host.trim()}>
              {t('add.esphome.add')}
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

// ================================================================ Z-Wave

interface ZStatus {
  homeId: string;
  inclusionState: string;
  nodes: number;
  pinRequired?: boolean;
  dsk?: string;
  lastIncluded?: { nodeId: number; at: number; lowSecurity?: boolean; deviceId: string };
  lastRemoved?: { nodeId: number; at: number };
}

export function ZWavePanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  if (!method.enabled) return <ZWaveEnable method={method} canAdmin={canAdmin} reload={reload} />;
  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {(!health || health.status === 'running') && (
        <>
          <ZWaveInclusion canAdmin={canAdmin} added={added} />
          <AddedDevices devices={added} openDevice={openDevice} />
          <ZWaveSmartStart canAdmin={canAdmin} />
        </>
      )}
      <Panel title={t('add.zwave.tipsTitle')} icon="info">
        <Steps items={[t('add.zwave.tip1'), t('add.zwave.tip2'), t('add.zwave.tip3')]} />
      </Panel>
    </>
  );
}

function ZWaveEnable({ method, canAdmin, reload }: { method: PluginMethod; canAdmin: boolean; reload: () => Promise<void> }) {
  const t = useT();
  const serial = useSerialPicker(canAdmin, { label: 'add.zwave.stick', empty: 'add.zwave.noPorts' });
  return (
    <EnablePlugin method={method} canAdmin={canAdmin} intro={t('add.zwave.enableIntro')} onEnabled={reload} config={() => (serial.path ? { port: serial.path } : null)}>
      {serial.field}
      <Note icon="key">{t('add.zwave.keysNote')}</Note>
    </EnablePlugin>
  );
}

function ZWaveInclusion({ canAdmin, added }: { canAdmin: boolean; added: DeviceDTO[] }) {
  const t = useT();
  const [status, setStatus] = useState<ZStatus | null>(null);
  // What was started from this panel, and when (older results belong to someone else).
  const [run, setRun] = useState<{ mode: 'include' | 'exclude'; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');

  const refresh = async () => {
    try {
      setStatus(await api.pluginAction<ZStatus>('zwave', 'status'));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmin]);

  const act = async (action: 'include' | 'exclude' | 'stop' | 'pin') => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.pluginAction<{ started?: boolean }>('zwave', action, action === 'pin' ? { pin } : {});
      if (action === 'include' || action === 'exclude') {
        if (res.started === false) setError(t('add.zwave.busy'));
        else setRun({ mode: action, at: Date.now() - 2000 });
      }
      if (action === 'pin') setPin('');
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const state = status?.inclusionState ?? 'idle';
  const active = state === 'including' || state === 'excluding';
  const joined = run?.mode === 'include' && status?.lastIncluded && status.lastIncluded.at >= run.at ? status.lastIncluded : undefined;
  const removed = run?.mode === 'exclude' && status?.lastRemoved && status.lastRemoved.at >= run.at ? status.lastRemoved : undefined;
  const ready = joined && added.some((d) => d.id === joined.deviceId);
  const body = state === 'including' ? t('add.zwave.includingBody') : state === 'excluding' ? t('add.zwave.excludingBody') : state === 'idle' ? t('add.zwave.idleBody') : t('add.zwave.otherBody', { state });

  return (
    <Panel
      title={t('add.zwave.pairTitle')}
      icon="activity"
      aside={active ? <Badge tone="amber">{state === 'including' ? t('add.zwave.adding') : t('add.zwave.removing')}</Badge> : status ? <Badge>{t('add.zwave.nodes', { n: status.nodes })}</Badge> : undefined}
    >
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
        <div className="relative grid size-[112px] shrink-0 place-items-center rounded-full bg-chip" aria-hidden="true">
          <Icon name={state === 'excluding' ? 'trash' : 'activity'} size={30} className={active ? 'text-amber-ink' : 'text-muted'} />
          {active && <span className="lv-pulse absolute inset-0 rounded-full border-2 border-amber/40" />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 max-sm:items-center max-sm:text-center">
          <p className="m-0 text-[13.5px] leading-relaxed text-pretty">{body}</p>
          {error && <ErrorNote>{error}</ErrorNote>}
          {canAdmin ? (
            <div className="flex flex-wrap gap-2">
              {active ? (
                <Button variant="primary" icon="stop" busy={busy} onClick={() => void act('stop')}>
                  {t('add.zwave.stop')}
                </Button>
              ) : (
                <>
                  <Button variant="amber" icon="plus" busy={busy} disabled={!status} onClick={() => void act('include')}>
                    {t('add.zwave.include')}
                  </Button>
                  <Button variant="ghost" icon="trash" disabled={busy || !status} onClick={() => void act('exclude')}>
                    {t('add.zwave.exclude')}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <Note icon="lock">{t('add.adminOnlyAction')}</Note>
          )}
        </div>
      </div>
      {status?.pinRequired && canAdmin && (
        <form
          className="flex flex-col gap-3 rounded-[14px] bg-amber-soft p-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d{5}$/.test(pin)) void act('pin');
          }}
        >
          <div className="flex items-start gap-2.5">
            <Icon name="key" size={17} className="mt-0.5 shrink-0 text-amber-ink" />
            <div className="min-w-0 text-[13px] leading-relaxed text-pretty">
              <div className="font-bold">{t('add.zwave.pinTitle')}</div>
              {t('add.zwave.pinBody')}
            </div>
          </div>
          {status.dsk && (
            <div className="overflow-x-auto font-mono text-[13px] font-bold tracking-[0.04em] whitespace-nowrap">
              <span className="text-amber-ink">_____</span>
              {dskRest(status.dsk).map((g) => `-${g}`).join('')}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 5))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="12345"
              aria-label={t('add.zwave.pinLabel')}
              className="min-h-12 w-[9ch] rounded-ctl border border-line bg-surface px-3.5 font-mono text-[20px] font-bold tracking-[0.12em] text-ink outline-none placeholder:text-muted/60 focus:border-amber-ink"
            />
            <Button type="submit" variant="amber" icon="check" busy={busy} disabled={pin.length !== 5}>
              {t('add.zwave.pinSubmit')}
            </Button>
          </div>
        </form>
      )}
      {joined && (
        <Note icon={joined.lowSecurity ? 'shieldAlert' : ready ? 'circleCheck' : 'loader'} tone={joined.lowSecurity ? 'amber' : 'ok'}>
          {ready ? t('add.zwave.joinedReady', { node: joined.nodeId }) : t('add.zwave.joinedInterview', { node: joined.nodeId })}
          {joined.lowSecurity && <div className="mt-1">{t('add.zwave.lowSecurity')}</div>}
        </Note>
      )}
      {removed && (
        <Note icon="circleCheck" tone="ok">
          {t('add.zwave.removed', { node: removed.nodeId })}
        </Note>
      )}
    </Panel>
  );
}

function ZWaveSmartStart({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanSupported, setScanSupported] = useState(false);
  useEffect(() => {
    void canScanQr().then(setScanSupported);
  }, []);

  const valid = isZwaveQr(qr);
  const submit = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api.pluginAction('zwave', 'provision', { qr: qr.trim() });
      setDone(true);
      setQr('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('add.zwave.smartTitle')} icon="scanQr">
      <p className="m-0 text-[13px] leading-relaxed text-pretty text-muted">{t('add.zwave.smartBody')}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && canAdmin) void submit();
        }}
      >
        <div className="flex items-end gap-2">
          <TextField
            className="min-w-0 flex-1 [&_input]:font-mono"
            label={t('add.zwave.qrLabel')}
            value={qr}
            onChange={(e) => {
              setQr(e.target.value.replace(/\s/g, ''));
              setDone(false);
            }}
            placeholder="9001234…"
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            disabled={!canAdmin}
          />
          {scanSupported && canAdmin && (
            <Button className="min-h-11 shrink-0" icon="scanQr" onClick={() => setScanning(true)}>
              <span className="max-sm:sr-only">{t('add.matter.scan')}</span>
            </Button>
          )}
        </div>
        {qr && !valid && <div className="text-xs text-muted">{t('add.zwave.qrInvalid')}</div>}
        {error && <ErrorNote>{error}</ErrorNote>}
        {done && (
          <Note icon="circleCheck" tone="ok">
            {t('add.zwave.provisioned')}
          </Note>
        )}
        {canAdmin && (
          <div>
            <Button type="submit" variant="amber" icon="plus" busy={busy} disabled={!valid}>
              {t('add.zwave.provision')}
            </Button>
          </div>
        )}
      </form>
      {scanning && (
        <QrScanner
          accept={/^90\d{50,}$/}
          onClose={() => setScanning(false)}
          onResult={(text) => {
            setScanning(false);
            setQr(text);
            toast(t('add.matter.scanned'));
          }}
        />
      )}
    </Panel>
  );
}

// ================================================================ Shelly

type ShellyState = 'connecting' | 'online' | 'auth' | 'offline' | 'error';
interface ShellyFound {
  host: string;
  name: string;
  model?: string;
  at: number;
  connected: boolean;
  state?: ShellyState;
}

export function ShellyPanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  if (!method.enabled) return <EnablePlugin method={method} canAdmin={canAdmin} intro={t('add.shelly.enableIntro')} onEnabled={reload} />;
  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {(!health || health.status === 'running') && (
        <>
          <ShellyDiscovered canAdmin={canAdmin} />
          <AddedDevices devices={added} openDevice={openDevice} />
          <ShellyManual canAdmin={canAdmin} />
        </>
      )}
    </>
  );
}

function ShellyDiscovered({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [list, setList] = useState<ShellyFound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  // Hosts the user asked to connect that need a password (from the device or from a failed attempt).
  const [asking, setAsking] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await api.pluginAction<ShellyFound[]>('shelly', 'discovered');
        if (!cancelled) (setList(res), setError(null));
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canAdmin]);

  const connect = async (d: ShellyFound, pw?: string) => {
    setConnecting(d.host);
    try {
      await api.pluginAction('shelly', 'add', { host: d.host, ...(pw ? { password: pw } : {}) });
      toast(t('add.shelly.connecting', { host: d.name || d.host }), 'info');
      setAsking(null);
      setPassword('');
      setList((l) => l?.map((x) => (x.host === d.host ? { ...x, connected: true, state: 'connecting' } : x)) ?? l);
    } catch (e) {
      if (/authentication|password/i.test(errorMessage(e))) setAsking(d.host);
      else toast(errorMessage(e), 'error');
    } finally {
      setConnecting(null);
    }
  };

  return (
    <Panel title={t('add.esphome.foundTitle')} icon="network" aside={list && canAdmin ? <Spinner size={14} className="text-muted" /> : undefined}>
      {!canAdmin ? (
        <Note icon="lock">{t('add.adminOnlyAction')}</Note>
      ) : error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !list ? (
        <div className="grid place-items-center py-6 text-muted">
          <Spinner size={18} />
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-5 text-center">
          <span className="grid size-12 place-items-center rounded-tile bg-chip text-muted">
            <Icon name="search" size={20} className="lv-pulse" />
          </span>
          <div className="text-[14px] font-bold">{t('add.shelly.searching')}</div>
          <p className="m-0 max-w-sm text-[12.5px] leading-relaxed text-pretty text-muted">{t('add.shelly.searchingHint')}</p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {list.map((d) => {
            const needsPassword = asking === d.host || d.state === 'auth';
            return (
              <li key={d.host} className="flex flex-col gap-2.5 rounded-[15px] bg-surface2 p-2.5 pr-3">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-chip">
                    <Icon name="zap" size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-bold">{d.name}</span>
                    <span className="block truncate font-mono text-[11.5px] text-muted">{[d.model, d.host].filter(Boolean).join(' · ')}</span>
                  </span>
                  {d.state === 'online' ? (
                    <Badge tone="ok">
                      <Dot tone="ok" />
                      {t('add.esphome.connected')}
                    </Badge>
                  ) : d.state === 'connecting' ? (
                    <Badge>
                      <Spinner size={11} />
                      {t('add.shelly.stateConnecting')}
                    </Badge>
                  ) : needsPassword ? (
                    <Badge tone="amber">
                      <Icon name="lock" size={12} />
                      {t('add.shelly.stateAuth')}
                    </Badge>
                  ) : (
                    <Button size="sm" variant={d.connected ? 'chip' : 'amber'} icon={d.connected ? 'rotateCcw' : 'plus'} busy={connecting === d.host} onClick={() => void connect(d)}>
                      {d.connected ? t('add.shelly.retry') : t('add.esphome.connect')}
                    </Button>
                  )}
                </div>
                {needsPassword && (
                  <form
                    className="flex items-end gap-2 pl-12"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (password) void connect(d, password);
                    }}
                  >
                    <TextField
                      className="min-w-0 flex-1"
                      label={t('add.shelly.password')}
                      type="password"
                      autoComplete="off"
                      value={asking === d.host || d.state === 'auth' ? password : ''}
                      onChange={(e) => {
                        setAsking(d.host);
                        setPassword(e.target.value);
                      }}
                    />
                    <Button type="submit" variant="amber" className="min-h-11" busy={connecting === d.host} disabled={!password || (asking !== null && asking !== d.host)}>
                      {t('add.esphome.connect')}
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function ShellyManual({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await api.pluginAction<{ model?: string }>('shelly', 'add', { host: host.trim(), ...(password ? { password } : {}) });
      setNote(t('add.shelly.addedNote', { host: [res.model, host.trim()].filter(Boolean).join(' · ') }));
      setHost('');
      setPassword('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('add.esphome.manualTitle')} icon="pencil">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (host.trim() && canAdmin) void submit();
        }}
      >
        <TextField label={t('add.esphome.host')} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" spellCheck={false} autoCapitalize="off" disabled={!canAdmin} />
        <TextField
          label={t('add.shelly.passwordOptional')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={t('add.shelly.passwordHint')}
          autoComplete="off"
          disabled={!canAdmin}
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        {note && (
          <Note icon="circleCheck" tone="ok">
            {note}
          </Note>
        )}
        {canAdmin && (
          <div>
            <Button type="submit" variant="amber" icon="plus" busy={busy} disabled={!host.trim()}>
              {t('add.esphome.add')}
            </Button>
          </div>
        )}
      </form>
      <p className="m-0 text-xs leading-relaxed text-pretty text-muted">{t('add.shelly.gen1')}</p>
    </Panel>
  );
}

// ================================================================ Philips Hue

interface HueBridgeRow {
  host: string;
  bridgeId: string | null;
  name: string | null;
  state: 'connecting' | 'online' | 'auth' | 'offline';
  devices: number;
}
interface HueFound {
  host: string;
  name: string;
  bridgeId?: string;
  paired: boolean;
}

const HUE_PAIR_SECONDS = 40;

export function HuePanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  if (!method.enabled) return <EnablePlugin method={method} canAdmin={canAdmin} intro={t('add.hue.enableIntro')} onEnabled={reload} />;
  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {(!health || health.status === 'running') && <HueBridges canAdmin={canAdmin} />}
      <AddedDevices devices={added} openDevice={openDevice} />
    </>
  );
}

function HueBridges({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [bridges, setBridges] = useState<HueBridgeRow[] | null>(null);
  const [found, setFound] = useState<HueFound[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ host: string; until: number } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const now = useTick(pairing !== null);

  const refresh = async () => {
    try {
      const [b, d] = await Promise.all([api.pluginAction<HueBridgeRow[]>('hue', 'bridges'), api.pluginAction<HueFound[]>('hue', 'discovered')]);
      setBridges(b);
      setFound(d.filter((x) => !x.paired));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmin]);

  // While waiting for the link button, retry the pairing call every 2.5 s.
  useEffect(() => {
    if (!pairing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      try {
        const res = await api.pluginAction<{ paired: boolean; name?: string }>('hue', 'pair', { host: pairing.host });
        if (cancelled) return;
        if (res.paired) {
          setPairing(null);
          setNote(t('add.hue.pairedNote', { name: res.name ?? pairing.host }));
          setHost('');
          void refresh();
          return;
        }
      } catch (e) {
        if (!cancelled) {
          setPairing(null);
          setPairError(errorMessage(e));
        }
        return;
      }
      if (Date.now() > pairing.until) {
        setPairing(null);
        setPairError(t('add.hue.pressTimeout'));
        return;
      }
      timer = setTimeout(attempt, 2500);
    };
    void attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing?.host, pairing?.until]);

  const pair = (h: string) => {
    setPairError(null);
    setNote(null);
    setPairing({ host: h.trim(), until: Date.now() + HUE_PAIR_SECONDS * 1000 });
  };

  const remove = async (b: HueBridgeRow) => {
    const name = b.name ?? b.host;
    if (!(await confirmDialog({ title: t('add.hue.removeConfirm', { name }), confirmLabel: t('add.hue.remove'), danger: true, icon: 'trash' }))) return;
    try {
      await api.pluginAction('hue', 'remove', { bridgeId: b.bridgeId ?? b.host });
      await refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (!canAdmin)
    return (
      <Panel title={t('add.hue.bridgesTitle')} icon="network">
        <Note icon="lock">{t('add.adminOnlyAction')}</Note>
      </Panel>
    );

  const remaining = pairing ? Math.max(0, Math.ceil((pairing.until - now) / 1000)) : 0;
  const stateText = (b: HueBridgeRow) => (b.state === 'online' ? t('add.hue.state.online', { n: b.devices }) : t(`add.hue.state.${b.state}` as MessageKey));

  return (
    <>
      {pairing && (
        <Panel title={t('add.hue.pressTitle')} icon="circleDot" aside={<Badge tone="amber">{remaining}s</Badge>}>
          <div className="flex items-center gap-4">
            <div className="relative grid size-20 shrink-0 place-items-center rounded-full bg-chip" aria-hidden="true">
              <span className="size-9 rounded-full border-4 border-amber" />
              <span className="lv-pulse absolute inset-0 rounded-full border-2 border-amber/40" />
            </div>
            <p className="m-0 min-w-0 flex-1 text-[13.5px] leading-relaxed text-pretty">{t('add.hue.pressBody')}</p>
          </div>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Panel>
      )}
      {pairError && <ErrorNote>{pairError}</ErrorNote>}
      {note && (
        <Note icon="circleCheck" tone="ok">
          {note}
        </Note>
      )}
      <Panel title={t('add.hue.bridgesTitle')} icon="network" aside={bridges ? <Spinner size={14} className="text-muted" /> : undefined}>
        {error ? (
          <ErrorNote>{error}</ErrorNote>
        ) : !bridges ? (
          <div className="grid place-items-center py-6 text-muted">
            <Spinner size={18} />
          </div>
        ) : bridges.length === 0 && found.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-5 text-center">
            <span className="grid size-12 place-items-center rounded-tile bg-chip text-muted">
              <Icon name="search" size={20} className="lv-pulse" />
            </span>
            <div className="text-[14px] font-bold">{t('add.hue.searching')}</div>
            <p className="m-0 max-w-sm text-[12.5px] leading-relaxed text-pretty text-muted">{t('add.hue.searchingHint')}</p>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {bridges.map((b) => (
              <li key={b.bridgeId ?? b.host} className="flex items-center gap-3 rounded-[15px] bg-surface2 p-2.5 pr-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-amber-soft text-amber-ink">
                  <Icon name="bulb" size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-bold">{b.name ?? 'Hue Bridge'}</span>
                  <span className="block truncate font-mono text-[11.5px] text-muted">{b.host}</span>
                </span>
                {b.state === 'auth' ? (
                  <Button size="sm" variant="amber" icon="rotateCcw" disabled={pairing !== null} onClick={() => pair(b.host)}>
                    {t('add.hue.state.auth')}
                  </Button>
                ) : (
                  <Badge tone={b.state === 'online' ? 'ok' : b.state === 'offline' ? 'alert' : 'chip'}>
                    {b.state === 'online' && <Dot tone="ok" />}
                    {stateText(b)}
                  </Badge>
                )}
                <Button size="sm" variant="ghost" icon="trash" aria-label={t('add.hue.remove')} onClick={() => void remove(b)} />
              </li>
            ))}
            {found.map((d) => (
              <li key={d.host} className="flex items-center gap-3 rounded-[15px] bg-surface2 p-2.5 pr-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-chip">
                  <Icon name="bulb" size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-bold">{d.name}</span>
                  <span className="block truncate font-mono text-[11.5px] text-muted">{d.host}</span>
                </span>
                <Button size="sm" variant="amber" icon="plus" busy={pairing?.host === d.host} disabled={pairing !== null} onClick={() => pair(d.host)}>
                  {t('add.hue.pair')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('add.hue.manualTitle')} icon="pencil">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (host.trim() && !pairing) pair(host);
          }}
        >
          <TextField className="min-w-0 flex-1" label={t('add.hue.host')} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.20" spellCheck={false} autoCapitalize="off" />
          <Button type="submit" variant="amber" className="min-h-11" icon="plus" disabled={!host.trim() || pairing !== null}>
            {t('add.hue.pair')}
          </Button>
        </form>
      </Panel>
    </>
  );
}

// ================================================================ Xiaomi / Mijia

interface XiaomiLogin {
  state: 'idle' | 'waiting' | 'done' | 'error';
  error?: string;
  loginUrl?: string;
  expiresAt?: number;
  signedIn: boolean;
  country: string;
  cloud: boolean;
  devices: number;
}
interface XiaomiDevice {
  did: string;
  id: string;
  name: string;
  model: string;
  host: string | null;
  mode: 'local' | 'cloud' | 'none';
  state: 'starting' | 'online' | 'offline' | 'unsupported' | 'error';
  error?: string;
}

const XIAOMI_REGIONS = ['cn', 'de', 'us', 'ru', 'sg', 'i2'] as const;

export function XiaomiPanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  const [country, setCountry] = useState('cn');
  const [cloud, setCloud] = useState(false);
  if (!method.enabled)
    return (
      <EnablePlugin method={method} canAdmin={canAdmin} intro={t('add.xiaomi.enableIntro')} onEnabled={reload} config={() => ({ country, cloud })}>
        <SelectField label={t('add.xiaomi.region')} value={country} onChange={setCountry} options={XIAOMI_REGIONS.map((r) => ({ value: r, label: t(`add.xiaomi.region.${r}` as MessageKey) }))} />
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13px] font-bold">{t('add.xiaomi.cloud')}</span>
            <span className="block text-xs text-muted">{t('add.xiaomi.cloudHint')}</span>
          </span>
          <Switch checked={cloud} onChange={setCloud} label={t('add.xiaomi.cloud')} />
        </div>
      </EnablePlugin>
    );
  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {(!health || health.status === 'running') && (
        <>
          <XiaomiAccount canAdmin={canAdmin} />
          <AddedDevices devices={added} openDevice={openDevice} />
          <XiaomiDevices canAdmin={canAdmin} />
          <XiaomiManual canAdmin={canAdmin} />
        </>
      )}
    </>
  );
}

function XiaomiAccount({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<XiaomiLogin | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const now = useTick(status?.state === 'waiting');

  const refresh = async () => {
    try {
      setStatus(await api.pluginAction<XiaomiLogin>('xiaomi', 'loginStatus'));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmin]);

  const run = async (action: 'login' | 'logout' | 'sync') => {
    setBusy(action);
    setError(null);
    setNote(null);
    try {
      const r = await api.pluginAction<{ devices?: number; local?: number }>('xiaomi', action);
      if (action === 'sync') setNote(t('add.xiaomi.synced', { n: r.devices ?? 0, local: r.local ?? 0 }));
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const qr = useMemo(() => (status?.state === 'waiting' && status.loginUrl ? renderSVG(status.loginUrl, { border: 1, pixelSize: 6, whiteColor: '#ffffff', blackColor: '#1f1a14' }) : null), [status?.state, status?.loginUrl]);
  const left = status?.expiresAt ? Math.max(0, Math.ceil((status.expiresAt - now) / 1000)) : 0;

  if (!canAdmin)
    return (
      <Panel title={t('add.xiaomi.accountTitle')} icon="key">
        <Note icon="lock">{t('add.adminOnlyAction')}</Note>
      </Panel>
    );

  return (
    <Panel
      title={t('add.xiaomi.accountTitle')}
      icon="key"
      aside={status?.signedIn ? <Badge tone="ok"><Dot tone="ok" />{t('add.xiaomi.signedIn')}</Badge> : undefined}
    >
      {!status ? (
        <div className="grid place-items-center py-6 text-muted">
          <Spinner size={18} />
        </div>
      ) : status.state === 'waiting' && qr ? (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="shrink-0 overflow-hidden rounded-[14px] border border-line bg-white p-1.5 [&_svg]:block [&_svg]:size-[180px]" dangerouslySetInnerHTML={{ __html: qr }} role="img" aria-label={t('add.xiaomi.qrLabel')} />
          <div className="flex min-w-0 flex-1 flex-col gap-3 max-sm:items-center max-sm:text-center">
            <Steps items={[t('add.xiaomi.scan1'), t('add.xiaomi.scan2'), t('add.xiaomi.scan3')]} />
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner size={12} /> {t('add.xiaomi.waiting', { s: left })}
            </div>
            <div>
              <Button size="sm" variant="ghost" onClick={() => void run('logout')}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </div>
      ) : status.signedIn ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[13.5px] leading-relaxed text-pretty">{t('add.xiaomi.signedInBody', { n: status.devices, region: t(`add.xiaomi.region.${status.country}` as MessageKey) })}</p>
          <div className="flex flex-wrap gap-2">
            <Button icon="rotateCcw" busy={busy === 'sync'} onClick={() => void run('sync')}>
              {t('add.xiaomi.sync')}
            </Button>
            <Button variant="ghost" icon="logOut" busy={busy === 'logout'} onClick={() => void run('logout')}>
              {t('add.xiaomi.signOut')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[13.5px] leading-relaxed text-pretty">{t('add.xiaomi.signInBody')}</p>
          {status.state === 'error' && status.error && <ErrorNote>{status.error}</ErrorNote>}
          <div>
            <Button variant="amber" icon="scanQr" busy={busy === 'login'} onClick={() => void run('login')}>
              {t('add.xiaomi.signIn')}
            </Button>
          </div>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && (
        <Note icon="circleCheck" tone="ok">
          {note}
        </Note>
      )}
      <p className="m-0 text-xs leading-relaxed text-pretty text-muted">{t('add.xiaomi.privacy')}</p>
    </Panel>
  );
}

function XiaomiDevices({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [list, setList] = useState<XiaomiDevice[] | null>(null);
  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.pluginAction<XiaomiDevice[]>('xiaomi', 'devices');
        if (!cancelled) setList(r);
      } catch {
        // shown by the account panel / plugin health
      }
      if (!cancelled) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canAdmin]);
  if (!canAdmin || !list?.length) return null;
  const order = { online: 0, starting: 1, offline: 2, error: 3, unsupported: 4 };
  const sorted = [...list].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  return (
    <Panel title={t('add.xiaomi.devicesTitle', { n: list.length })} icon="list">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {sorted.map((d) => (
          <li key={d.did} className={cx('flex items-center gap-3 rounded-[15px] bg-surface2 p-2.5 pr-3', d.state === 'unsupported' && 'opacity-70')}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-bold">{d.name || d.model}</span>
              <span className="block truncate font-mono text-[11.5px] text-muted">{[d.model, d.host].filter(Boolean).join(' · ')}</span>
              {d.error && d.state !== 'online' && <span className="block text-[12px] leading-snug text-pretty text-muted">{d.error}</span>}
            </span>
            {d.mode !== 'none' && <Badge>{d.mode === 'local' ? t('add.xiaomi.local') : t('add.xiaomi.viaCloud')}</Badge>}
            <Badge tone={d.state === 'online' ? 'ok' : d.state === 'offline' || d.state === 'error' ? 'alert' : 'chip'}>
              {d.state === 'online' && <Dot tone="ok" />}
              {t(`add.xiaomi.state.${d.state}` as MessageKey)}
            </Badge>
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs leading-relaxed text-pretty text-muted">{t('add.xiaomi.devicesFoot')}</p>
    </Panel>
  );
}

function XiaomiManual({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const valid = host.trim() && /^[0-9a-f]{32}$/i.test(token.trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.pluginAction<{ model: string }>('xiaomi', 'add', { host: host.trim(), token: token.trim() });
      setNote(t('add.xiaomi.manualAdded', { model: r.model || host.trim() }));
      setHost('');
      setToken('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t('add.xiaomi.manualTitle')} icon="pencil">
      <Advanced label={t('add.xiaomi.manualToggle')}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && canAdmin) void submit();
          }}
        >
          <TextField label={t('add.esphome.host')} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.40" spellCheck={false} autoCapitalize="off" disabled={!canAdmin} />
          <TextField label="Token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="32 位十六进制" hint={t('add.xiaomi.tokenHint')} spellCheck={false} autoCapitalize="off" autoComplete="off" className="[&_input]:font-mono" disabled={!canAdmin} />
          {error && <ErrorNote>{error}</ErrorNote>}
          {note && (
            <Note icon="circleCheck" tone="ok">
              {note}
            </Note>
          )}
          {canAdmin && (
            <div>
              <Button type="submit" variant="amber" icon="plus" busy={busy} disabled={!valid}>
                {t('add.esphome.add')}
              </Button>
            </div>
          )}
        </form>
      </Advanced>
    </Panel>
  );
}

// ================================================================ MQTT

export function MqttPanel({ method, added, openDevice }: PanelProps<MqttMethod>) {
  const t = useT();
  const broker = method.broker;
  const server = useMemo(() => {
    if (!broker) return 'mqtt://<livynq-host>:1883';
    if (broker.url) return broker.url.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/, `//${location.hostname}`);
    return `mqtt://${location.hostname}:${broker.port}`;
  }, [broker]);
  const prefix = broker?.discoveryPrefix ?? 'homeassistant';
  const z2m = [
    '# Zigbee2MQTT 1.x: homeassistant: true',
    'homeassistant:',
    '  enabled: true',
    ...(prefix !== 'homeassistant' ? [`  discovery_topic: ${prefix}`] : []),
    'mqtt:',
    `  server: ${server}`,
  ].join('\n');
  const configured = method.enabled || Boolean(broker?.builtin);

  return (
    <>
      <Note icon={method.enabled ? 'circleCheck' : 'info'} tone={method.enabled ? 'ok' : 'chip'}>
        <div className="font-bold">{method.enabled ? t('add.mqtt.on') : t('add.mqtt.off')}</div>
        <div>{t('add.mqtt.body')}</div>
      </Note>
      <Panel title={t('add.mqtt.brokerTitle')} icon="radio">
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13.5px]">
          <dt className="text-muted">{t('add.mqtt.broker')}</dt>
          <dd className="m-0 font-mono text-[12.5px] break-all">{broker?.url || (broker?.builtin ? server : '—')}</dd>
          <dt className="text-muted">{t('add.mqtt.builtin')}</dt>
          <dd className="m-0">{broker ? (broker.builtin ? t('add.mqtt.builtinOn', { port: broker.port }) : t('settings.disabled')) : '—'}</dd>
          <dt className="text-muted">{t('add.mqtt.prefix')}</dt>
          <dd className="m-0 font-mono text-[12.5px]">{prefix}</dd>
        </dl>
        {!configured && (
          <>
            <p className="m-0 text-[13px] leading-relaxed text-muted">{t('add.mqtt.setup')}</p>
            <CodeBlock label="livynq.yaml" code={'mqtt:\n  broker:\n    builtin: true\n  # or an existing broker:\n  # url: mqtt://user:pass@broker:1883'} />
          </>
        )}
      </Panel>
      <Panel title="Zigbee2MQTT" icon="usb">
        <p className="m-0 text-[13px] leading-relaxed text-muted">{t('add.mqtt.z2m')}</p>
        <CodeBlock code={z2m} label="configuration.yaml" />
      </Panel>
      <Panel title="Tasmota" icon="plug">
        <p className="m-0 text-[13px] leading-relaxed text-muted">{t('add.mqtt.tasmota')}</p>
        <CodeBlock code={`SetOption19 1`} label={t('add.mqtt.tasmotaConsole')} />
      </Panel>
      <Panel title="ESPHome (MQTT)" icon="cpu">
        <p className="m-0 text-[13px] leading-relaxed text-muted">{t('add.mqtt.esphome')}</p>
        <CodeBlock label="ESPHome YAML" code={`mqtt:\n  broker: ${server.replace(/^mqtts?:\/\//, '').replace(/:\d+$/, '')}\n  discovery: true${prefix !== 'homeassistant' ? `\n  discovery_prefix: ${prefix}` : ''}`} />
      </Panel>
      <AddedDevices devices={added} openDevice={openDevice} />
    </>
  );
}

// ================================================================ Home Assistant

export function HomeAssistantPanel({ method, canAdmin, added, reload, openDevice, health, refreshPlugins }: PanelProps<PluginMethod>) {
  const t = useT();
  const [url, setUrl] = useState('http://homeassistant.local:8123');
  const [token, setToken] = useState('');
  const { devices } = useLive();
  const total = useMemo(() => Object.values(devices).filter((d) => d.adapter === 'homeassistant').length, [devices]);

  if (!method.enabled)
    return (
      <EnablePlugin
        method={method}
        canAdmin={canAdmin}
        intro={t('add.ha.enableIntro')}
        onEnabled={reload}
        config={() => (/^https?:\/\/.+/i.test(url.trim()) && token.trim().length > 20 ? { url: url.trim().replace(/\/+$/, ''), token: token.trim() } : null)}
      >
        <TextField label={t('add.ha.url')} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://homeassistant.local:8123" spellCheck={false} autoCapitalize="off" inputMode="url" />
        <TextField label={t('add.ha.token')} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="eyJhbGciOi…" className="[&_input]:font-mono" />
        <div className="flex flex-col gap-2.5 rounded-ctl bg-surface2 p-3.5">
          <div className="text-[12.5px] font-bold text-muted">{t('add.ha.tokenHow')}</div>
          <Steps items={[t('add.ha.token1'), t('add.ha.token2'), t('add.ha.token3')]} />
        </div>
      </EnablePlugin>
    );

  return (
    <>
      <PluginHealth info={health} refresh={refreshPlugins} />
      {(!health || health.status === 'running') && (
        <Note icon="circleCheck" tone="ok">
          <div className="font-bold">{t('add.ha.on')}</div>
          <div>{t('add.ha.onBody', { n: total })}</div>
        </Note>
      )}
      <AddedDevices devices={added} openDevice={openDevice} />
      <Panel title={t('add.ha.filterTitle')} icon="sliders">
        <p className="m-0 text-[13px] leading-relaxed text-muted">{t('add.ha.filterBody')}</p>
        <CodeBlock label="livynq.yaml" code={'plugins:\n  - module: "@livynq/plugin-homeassistant"\n    config:\n      url: …\n      token: …\n      include: ["light.*", "switch.*", "sensor.*_temperature"]\n      exclude: ["*.ups_*"]'} />
      </Panel>
    </>
  );
}

// ================================================================ Virtual switch

export function VirtualPanel({ method, canAdmin, added, reload, openDevice }: PanelProps<PluginMethod>) {
  const t = useT();
  const [name, setName] = useState('');
  const [momentary, setMomentary] = useState(false);
  const { devices } = useLive();
  const existing = useMemo(() => Object.values(devices).filter((d) => d.adapter === 'virtual'), [devices]);

  if (!method.enabled)
    return (
      <EnablePlugin
        method={method}
        canAdmin={canAdmin}
        intro={t('add.virtual.enableIntro')}
        onEnabled={reload}
        config={() => (name.trim() ? { switches: [{ id: slugId(name.trim()), name: name.trim(), ...(momentary ? { momentary: true } : {}) }] } : null)}
      >
        <TextField label={t('add.virtual.switchName')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('add.virtual.placeholder')} maxLength={60} />
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-ctl bg-surface2 px-3.5 py-3">
          <span className="flex flex-col">
            <span className="text-[13.5px] font-bold">{t('add.virtual.momentary')}</span>
            <span className="text-xs text-muted">{t('add.virtual.momentaryHint')}</span>
          </span>
          <Switch checked={momentary} onChange={setMomentary} label={t('add.virtual.momentary')} />
        </label>
      </EnablePlugin>
    );

  return (
    <>
      <Note icon="info">
        <div className="font-bold">{t('add.virtual.on')}</div>
        <div>{t('add.virtual.onBody')}</div>
      </Note>
      <AddedDevices devices={added.length ? added : existing} openDevice={openDevice} title={added.length ? undefined : t('add.virtual.existing', { n: existing.length })} />
      <Panel title={t('add.virtual.moreTitle')} icon="code">
        <CodeBlock
          label="livynq.yaml"
          code={`plugins:\n  - module: "@livynq/plugin-virtual"\n    config:\n      switches:\n${[...existing.map((d) => `        - { id: ${d.id.replace(/^virtual:/, '')}, name: ${JSON.stringify(d.name)} }`), '        - { id: movie-time, name: "Movie Time", momentary: true }   # new'].join('\n')}`}
        />
        <p className="m-0 text-xs leading-relaxed text-muted">{t('add.virtual.restart')}</p>
      </Panel>
    </>
  );
}
