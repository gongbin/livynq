import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  canScanQr,
  classifyCommissionError,
  createQrDetector,
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
function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
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
            const matter = codes.find((c) => /^MT:/i.test(c.rawValue));
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

function ZigbeeEnable({ method, canAdmin, reload }: { method: PluginMethod; canAdmin: boolean; reload: () => Promise<void> }) {
  const t = useT();
  const [ports, setPorts] = useState<{ path: string; label: string }[] | null>(null);
  const [choice, setChoice] = useState('');
  const [custom, setCustom] = useState('');
  const [adapter, setAdapter] = useState('');
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

  const serialPort = choice === CUSTOM ? custom.trim() : choice;
  return (
    <EnablePlugin
      method={method}
      canAdmin={canAdmin}
      intro={t('add.zigbee.enableIntro')}
      onEnabled={reload}
      config={() => (serialPort ? { serialPort, ...(adapter ? { adapter } : {}) } : null)}
    >
      {ports && ports.length === 0 && <Note icon="usb">{t('add.zigbee.noPorts')}</Note>}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <SelectField
            label={t('add.zigbee.port')}
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
