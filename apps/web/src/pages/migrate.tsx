import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Note, Panel, Steps } from '../components/add-device.tsx';
import { useSerialPicker } from '../components/add-device-methods.tsx';
import { confirmDialog } from '../components/dialog.tsx';
import { Icon, type IconName } from '../components/icons.tsx';
import { toast } from '../components/toast.tsx';
import { Badge, Button, Card, Dot, ErrorNote, PageHeader, SectionLabel, Spinner, Switch, TextField, cx } from '../components/ui.tsx';
import { api, errorMessage, type ImportPlan, type ImportRecord, type ImportSource } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { useLang, useT, type MessageKey } from '../lib/i18n.ts';
import { href } from '../lib/router.ts';
import { useCan } from '../lib/session.ts';

type Source = 'ha' | 'z2m';

/** Migration: Home Assistant import (scan → dry-run report → apply → undo) and Zigbee2MQTT takeover. */
export function MigratePage() {
  const t = useT();
  const canAdmin = useCan('admin');
  const [source, setSource] = useState<Source | null>(null);
  const [history, setHistory] = useState<ImportRecord[] | null>(null);

  const loadHistory = async () => {
    if (!canAdmin) return;
    try {
      setHistory(await api.imports());
    } catch {
      setHistory([]);
    }
  };
  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmin]);

  return (
    <>
      <PageHeader
        title={t('migrate.title')}
        subtitle={t('migrate.subtitle')}
        actions={
          source && (
            <Button icon="chevronLeft" onClick={() => setSource(null)}>
              {t('migrate.back')}
            </Button>
          )
        }
      />
      {!canAdmin ? (
        <Note icon="lock">{t('migrate.adminOnly')}</Note>
      ) : source === 'ha' ? (
        <HomeAssistantImport onDone={loadHistory} />
      ) : source === 'z2m' ? (
        <Zigbee2MqttTakeover />
      ) : (
        <SourceChooser onChoose={setSource} />
      )}
      {canAdmin && history && history.length > 0 && <ImportHistory list={history} onChange={loadHistory} />}
    </>
  );
}

// ---------------------------------------------------------------- step 1: source

function SourceChooser({ onChoose }: { onChoose: (s: Source) => void }) {
  const t = useT();
  const sources: { id: Source | null; name: string; icon: IconName; desc: MessageKey; note?: MessageKey }[] = [
    { id: 'ha', name: 'Home Assistant', icon: 'home', desc: 'migrate.ha' },
    { id: 'z2m', name: 'Zigbee2MQTT', icon: 'usb', desc: 'migrate.z2m' },
    { id: null, name: 'Homebridge', icon: 'share', desc: 'migrate.homebridge', note: 'migrate.homebridgeMeanwhile' },
    { id: null, name: 'zwave-js-ui', icon: 'activity', desc: 'migrate.zwave', note: 'migrate.zwaveMeanwhile' },
  ];
  return (
    <Card className="flex flex-col gap-4">
      <div className="text-[17px] font-extrabold">{t('migrate.from')}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sources.map((s) =>
          s.id ? (
            <button
              key={s.name}
              type="button"
              onClick={() => onChoose(s.id!)}
              className="group flex items-start gap-3.5 rounded-card border-[1.5px] border-line bg-surface p-4 text-left text-ink transition-[border-color,transform] duration-base hover:border-amber active:scale-[0.99]"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-tile bg-amber-soft text-amber-ink">
                <Icon name={s.icon} size={20} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[15.5px] font-extrabold">{s.name}</span>
                <span className="text-[13px] leading-snug text-pretty text-muted">{t(s.desc)}</span>
              </span>
              <Icon name="chevronRight" size={18} className="mt-3 shrink-0 text-muted transition-transform duration-base group-hover:translate-x-0.5" />
            </button>
          ) : (
            <div key={s.name} className="flex items-start gap-3.5 rounded-card border-[1.5px] border-dashed border-line p-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-tile bg-chip text-muted">
                <Icon name={s.icon} size={20} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15.5px] font-extrabold text-muted">{s.name}</span>
                  <Badge>{t('migrate.planned')}</Badge>
                </span>
                <span className="text-[13px] leading-snug text-pretty text-muted">{t(s.desc)}</span>
                {s.note && <span className="mt-1 text-[12.5px] leading-snug text-pretty">{t(s.note)}</span>}
              </span>
            </div>
          ),
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Home Assistant

type HaPhase =
  | { kind: 'pick' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'planning' }
  | { kind: 'plan'; source: ImportSource; plan: ImportPlan }
  | { kind: 'applying'; source: ImportSource; plan: ImportPlan }
  | { kind: 'done'; record: ImportRecord };

function MigrateSteps({ step }: { step: number }) {
  const t = useT();
  const steps: MessageKey[] = ['migrate.step.scan', 'migrate.step.report', 'migrate.step.apply', 'migrate.step.verify'];
  return (
    <ol className="m-0 grid list-none grid-cols-4 gap-2 p-0" aria-label={t('add.steps')}>
      {steps.map((s, i) => (
        <li key={s} className="flex flex-col gap-1.5" aria-current={i === step ? 'step' : undefined}>
          <div className={cx('h-1 rounded-full transition-colors duration-slow', i <= step ? 'bg-amber' : 'bg-chip')} />
          <div className={cx('flex items-center gap-1.5 text-[12.5px] font-bold', i === step ? 'text-ink' : 'text-muted')}>
            <span className="font-mono text-[10.5px]">0{i + 1}</span>
            <span className="truncate">{t(s)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function HomeAssistantImport({ onDone }: { onDone: () => Promise<void> }) {
  const t = useT();
  const [phase, setPhase] = useState<HaPhase>({ kind: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [enableAutomations, setEnableAutomations] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const plan = async (source: ImportSource) => {
    setPhase({ kind: 'planning' });
    try {
      setPhase({ kind: 'plan', source, plan: await api.planImport(source) });
    } catch (e) {
      setError(errorMessage(e));
      setPhase({ kind: 'pick' });
    }
  };

  const uploadFile = async (file: File) => {
    setError(null);
    setPhase({ kind: 'uploading', progress: 0 });
    try {
      const { upload } = await api.uploadImport(file, file.name, (progress) => setPhase({ kind: 'uploading', progress }));
      await plan({ upload });
    } catch (e) {
      setError(errorMessage(e));
      setPhase({ kind: 'pick' });
    }
  };

  const apply = async (source: ImportSource, p: ImportPlan) => {
    const ok = await confirmDialog({
      title: t('migrate.confirmTitle'),
      body: t('migrate.confirmBody', { rooms: p.summary.rooms, devices: p.summary.devicesMatched, automations: p.summary.automations }),
      confirmLabel: t('migrate.apply'),
      icon: 'import',
    });
    if (!ok) return;
    setPhase({ kind: 'applying', source, plan: p });
    try {
      const res = await api.applyImport(source, enableAutomations);
      setPhase({ kind: 'done', record: res.import });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      setPhase({ kind: 'plan', source, plan: p });
    }
  };

  const step = phase.kind === 'pick' || phase.kind === 'uploading' || phase.kind === 'planning' ? 0 : phase.kind === 'plan' ? 1 : phase.kind === 'applying' ? 2 : 3;

  return (
    <div className="flex flex-col gap-4">
      <MigrateSteps step={step} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {(phase.kind === 'pick' || phase.kind === 'uploading' || phase.kind === 'planning') && (
        <>
          <Panel title={t('migrate.ha.uploadTitle')} icon="upload">
            <p className="m-0 text-[13.5px] leading-relaxed text-pretty text-muted">{t('migrate.ha.uploadBody')}</p>
            <input
              ref={fileInput}
              type="file"
              accept=".tar,.tgz,.gz,application/x-tar,application/gzip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadFile(f);
              }}
            />
            {phase.kind === 'uploading' ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[13px] font-bold">
                  <span>{t('migrate.ha.uploading')}</span>
                  <span className="font-mono text-xs text-muted">{Math.round(phase.progress * 100)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-chip">
                  <div className="h-full rounded-full bg-amber transition-[width]" style={{ width: `${phase.progress * 100}%` }} />
                </div>
              </div>
            ) : phase.kind === 'planning' ? (
              <div className="flex items-center gap-2 text-[13.5px] text-muted">
                <Spinner size={15} /> {t('migrate.ha.scanning')}
              </div>
            ) : (
              <div>
                <Button variant="amber" icon="upload" onClick={() => fileInput.current?.click()}>
                  {t('migrate.ha.choose')}
                </Button>
              </div>
            )}
            <Steps items={[t('migrate.ha.howto1'), t('migrate.ha.howto2'), t('migrate.ha.howto3')]} />
          </Panel>
          <Panel title={t('migrate.ha.pathTitle')} icon="pencil">
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                if (path.trim()) void plan({ path: path.trim() });
              }}
            >
              <TextField
                className="min-w-0 flex-1 [&_input]:font-mono"
                label={t('migrate.ha.path')}
                hint={t('migrate.ha.pathHint')}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/config  ·  /backup/abcd1234.tar"
                spellCheck={false}
                autoCapitalize="off"
              />
              <Button type="submit" className="min-h-11 sm:mb-[22px]" icon="search" disabled={!path.trim() || phase.kind !== 'pick'}>
                {t('migrate.ha.scan')}
              </Button>
            </form>
          </Panel>
        </>
      )}
      {(phase.kind === 'plan' || phase.kind === 'applying') && (
        <>
          <PlanReport plan={phase.plan} />
          <Panel title={t('migrate.applyTitle')} icon="import">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-bold">{t('migrate.enableAutomations')}</span>
                <span className="block text-xs leading-relaxed text-pretty text-muted">{t('migrate.enableAutomationsHint')}</span>
              </span>
              <Switch checked={enableAutomations} onChange={setEnableAutomations} label={t('migrate.enableAutomations')} />
            </div>
            <p className="m-0 text-[13px] leading-relaxed text-pretty text-muted">{t('migrate.applyBody')}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="amber" icon="import" busy={phase.kind === 'applying'} onClick={() => void apply(phase.source, phase.plan)}>
                {t('migrate.apply')}
              </Button>
              <Button variant="ghost" disabled={phase.kind === 'applying'} onClick={() => setPhase({ kind: 'pick' })}>
                {t('migrate.startOver')}
              </Button>
            </div>
          </Panel>
        </>
      )}
      {phase.kind === 'done' && <ImportResult record={phase.record} />}
    </div>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'ok' | 'amber' | 'alert' }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-tile bg-surface2 px-3.5 py-3">
      <span className={cx('font-mono text-[22px] leading-none font-bold tabular-nums', tone === 'alert' && value ? 'text-alert' : tone === 'amber' && value ? 'text-amber-ink' : '')}>{value}</span>
      <span className="text-[12px] font-semibold text-muted">{label}</span>
    </div>
  );
}

function Details({ title, count, children, open }: { title: string; count: number; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-ctl border border-line px-3.5 py-2.5 [&[open]]:pb-3.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[13.5px] font-bold select-none [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          {title}
          <Badge>{count}</Badge>
        </span>
        <Icon name="chevronDown" size={16} className="text-muted transition-transform duration-base group-open:rotate-180" />
      </summary>
      <div className="mt-3 flex flex-col gap-1.5">{children}</div>
    </details>
  );
}

function Row({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[12px] bg-surface2 px-3 py-2 text-[13px]">
      <div className="min-w-0 flex-1">{children}</div>
      {aside}
    </div>
  );
}

function PlanReport({ plan }: { plan: ImportPlan }) {
  const t = useT();
  const s = plan.summary;
  const pending = plan.devices.filter((d) => d.status !== 'matched');
  const matched = plan.devices.filter((d) => d.status === 'matched');
  const renames = plan.devices.flatMap((d) => d.entities.filter((e) => e.status === 'rename'));
  const automations = plan.automations;
  const skipped = Object.entries(plan.notImported).filter(([, n]) => n > 0);
  return (
    <Panel title={t('migrate.reportTitle')} icon="list" aside={<Badge tone="amber">{t('migrate.dryRun')}</Badge>}>
      <div className="text-[12.5px] text-muted">
        {[plan.source, plan.haVersion && `Home Assistant ${plan.haVersion}`].filter(Boolean).join(' · ')}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat value={s.rooms} label={t('migrate.stat.rooms')} />
        <Stat value={s.devicesMatched} label={t('migrate.stat.matched')} tone="ok" />
        <Stat value={s.devicesPending + s.devicesUnsupported} label={t('migrate.stat.pending')} tone="amber" />
        <Stat value={s.automations} label={t('migrate.stat.automations')} />
      </div>
      {plan.warnings.map((w) => (
        <Note key={w} icon="alert" tone="amber">
          {w}
        </Note>
      ))}
      <Details title={t('migrate.sec.rooms')} count={plan.rooms.length}>
        {plan.rooms.map((r) => (
          <Row key={r.areaId} aside={<Badge tone={r.action === 'create' ? 'amber' : 'ok'}>{r.action === 'create' ? t('migrate.room.create') : t('migrate.room.match')}</Badge>}>
            <span className="font-bold">{r.name}</span>
          </Row>
        ))}
      </Details>
      <Details title={t('migrate.sec.matched')} count={matched.length}>
        {matched.map((d) => (
          <Row key={d.haDeviceId} aside={<Badge tone="ok">{d.integration}</Badge>}>
            <span className="block font-bold">{d.name}</span>
            <span className="block text-xs text-muted">{[d.area, d.manufacturer, d.model].filter(Boolean).join(' · ')}</span>
          </Row>
        ))}
      </Details>
      <Details title={t('migrate.sec.pending')} count={pending.length} open={pending.length > 0}>
        <p className="m-0 mb-1 text-xs leading-relaxed text-pretty text-muted">{t('migrate.pendingHint')}</p>
        {pending.map((d) => (
          <Row key={d.haDeviceId} aside={<Badge tone={d.status === 'unsupported' ? 'alert' : 'amber'}>{d.integration}</Badge>}>
            <span className="block font-bold">{d.name}</span>
            {d.reason && <span className="block text-xs leading-relaxed text-pretty text-muted">{d.reason}</span>}
          </Row>
        ))}
      </Details>
      <Details title={t('migrate.sec.renames')} count={renames.length}>
        <p className="m-0 mb-1 text-xs leading-relaxed text-pretty text-muted">{t('migrate.renamesHint')}</p>
        {renames.map((e) => (
          <Row key={e.haEntityId}>
            <span className="font-mono text-[12px] break-all">
              {e.livynqEntityId} <span className="text-muted">→</span> {e.haEntityId}
            </span>
          </Row>
        ))}
      </Details>
      <Details title={t('migrate.sec.automations')} count={automations.length} open={s.automationsInvalid > 0}>
        {automations.map((a) => (
          <Row
            key={a.id}
            aside={<Badge tone={a.status === 'import' ? 'ok' : a.status === 'exists' ? 'chip' : 'alert'}>{t(`migrate.auto.${a.status}` as MessageKey)}</Badge>}
          >
            <span className="block font-bold">{a.alias}</span>
            {a.errors.map((err) => (
              <span key={err} className="block text-xs leading-relaxed text-alert">
                {err}
              </span>
            ))}
            {a.missingEntities.length > 0 && <span className="block font-mono text-[11.5px] break-all text-muted">{t('migrate.auto.missing', { list: a.missingEntities.join(', ') })}</span>}
          </Row>
        ))}
      </Details>
      {skipped.length > 0 && (
        <Note icon="info">
          {t('migrate.notImported', { list: skipped.map(([k, n]) => `${t(`migrate.kind.${k}` as MessageKey)} ${n}`).join(' · ') })}
        </Note>
      )}
    </Panel>
  );
}

function ImportResult({ record }: { record: ImportRecord }) {
  const t = useT();
  const failed = record.applied.failed;
  return (
    <Panel title={t('migrate.doneTitle')} icon="circleCheck" aside={<Badge tone={failed.length ? 'amber' : 'ok'}>{t('migrate.doneOps', { n: record.applied.operations })}</Badge>}>
      <p className="m-0 text-[13.5px] leading-relaxed text-pretty">{t('migrate.doneBody')}</p>
      {failed.length > 0 && (
        <ErrorNote>
          <span className="flex flex-col gap-1">
            <span className="font-bold">{t('migrate.failed', { n: failed.length })}</span>
            {failed.slice(0, 8).map((f, i) => (
              <span key={i} className="font-mono text-[12px] break-words">
                {String(f.operation.op)}: {f.error}
              </span>
            ))}
          </span>
        </ErrorNote>
      )}
      <Steps items={[t('migrate.verify1'), t('migrate.verify2'), t('migrate.verify3')]} />
      <div className="flex flex-wrap gap-2">
        <a href={href('devices')} className="no-underline">
          <Button variant="primary" icon="list">
            {t('nav.devices')}
          </Button>
        </a>
        <a href={href('rooms')} className="no-underline">
          <Button icon="layers">{t('nav.rooms')}</Button>
        </a>
        <a href={href('automations')} className="no-underline">
          <Button icon="workflow">{t('nav.automations')}</Button>
        </a>
      </div>
    </Panel>
  );
}

function ImportHistory({ list, onChange }: { list: ImportRecord[]; onChange: () => Promise<void> }) {
  const t = useT();
  const lang = useLang();
  const [busy, setBusy] = useState<string | null>(null);
  const revert = async (r: ImportRecord) => {
    const ok = await confirmDialog({ title: t('migrate.revertTitle'), body: t('migrate.revertBody'), confirmLabel: t('migrate.revert'), icon: 'rotateCcw', danger: true });
    if (!ok) return;
    setBusy(r.id);
    try {
      const res = await api.revertImport(r.id);
      toast(t('migrate.reverted', { n: res.reverted }));
      await onChange();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="flex flex-col gap-1">
      <SectionLabel className="mb-2">{t('migrate.history')}</SectionLabel>
      {list.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-3 border-t border-line py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-chip text-muted">
            <Icon name="import" size={15} />
          </span>
          <div className="min-w-[160px] flex-1">
            <div className="truncate text-sm font-bold">{r.source.replace(/^homeassistant:/, 'Home Assistant · ')}</div>
            <div className="text-xs text-muted">
              {formatDateTime(r.createdAt, lang)} · {t('migrate.historySummary', { rooms: r.summary.rooms, devices: r.summary.devicesMatched, automations: r.summary.automations })}
            </div>
          </div>
          {r.revertedAt ? (
            <Badge>{t('migrate.revertedBadge')}</Badge>
          ) : (
            <Button size="sm" icon="rotateCcw" busy={busy === r.id} onClick={() => void revert(r)}>
              {t('migrate.revert')}
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------- Zigbee2MQTT

function Zigbee2MqttTakeover() {
  const t = useT();
  const [zigbee, setZigbee] = useState<'loading' | 'off' | 'on'>('loading');
  const [dataDir, setDataDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const serial = useSerialPicker(true);

  useEffect(() => {
    api.onboarding().then(
      (o) => setZigbee(o.methods.find((m) => m.id === 'zigbee')?.enabled ? 'on' : 'off'),
      () => setZigbee('off'),
    );
  }, []);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.enablePlugin('@livynq/plugin-zigbee', { serialPort: serial.path, takeOverZigbee2mqtt: dataDir.trim() });
      const status = (res as { status?: string; lastError?: string | null }).status;
      const lastError = (res as { lastError?: string | null }).lastError;
      if (status === 'crashed' || status === 'disabled') throw new Error(lastError ?? status);
      setDone(t('migrate.z2m.done'));
      setZigbee('on');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('migrate.z2m.title')} icon="usb">
        <p className="m-0 text-[13.5px] leading-relaxed text-pretty text-muted">{t('migrate.z2m.body')}</p>
        <Steps items={[t('migrate.z2m.step1'), t('migrate.z2m.step2'), t('migrate.z2m.step3')]} />
      </Panel>
      {zigbee === 'loading' ? (
        <div className="grid place-items-center py-8 text-muted">
          <Spinner size={18} />
        </div>
      ) : done ? (
        <Note icon="circleCheck" tone="ok">
          {done}{' '}
          <a href={href('devices')} className="font-bold text-ink">
            {t('nav.devices')} →
          </a>
        </Note>
      ) : zigbee === 'on' ? (
        <Note icon="info" tone="amber">
          {t('migrate.z2m.alreadyOn')}
        </Note>
      ) : (
        <Panel title={t('migrate.z2m.formTitle')} icon="pencil">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (serial.path && dataDir.trim() && !busy) void enable();
            }}
          >
            {serial.field}
            <TextField
              className="[&_input]:font-mono"
              label={t('migrate.z2m.dataDir')}
              hint={t('migrate.z2m.dataDirHint')}
              value={dataDir}
              onChange={(e) => setDataDir(e.target.value)}
              placeholder="/opt/zigbee2mqtt/data"
              spellCheck={false}
              autoCapitalize="off"
            />
            <Note icon="alert" tone="amber">
              {t('migrate.z2m.stopFirst')}
            </Note>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div>
              <Button type="submit" variant="amber" icon="power" busy={busy} disabled={!serial.path || !dataDir.trim()}>
                {t('migrate.z2m.cta')}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <StatusLegend />
    </div>
  );
}

/** Small reassurance at the bottom: what stays untouched. */
function StatusLegend() {
  const t = useT();
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <Dot tone="ok" />
      {t('migrate.z2m.safe')}
    </div>
  );
}
