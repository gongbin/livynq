import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../components/icons.tsx';
import { toast } from '../components/toast.tsx';
import { Badge, Button, Card, ConfirmButton, CopyButton, Dot, ErrorNote, SectionLabel, Segmented, Spinner, cx } from '../components/ui.tsx';
import { api, errorMessage, type AutomationInfo, type AutomationVersion, type Trace } from '../lib/api.ts';
import {
  automationFlow,
  describeAction,
  describeCondition,
  formatSpan,
  humanError,
  humanPath,
  isDraftSource,
  resolvePath,
  toYaml,
  webhookIds,
  type FlowKind,
  type SummaryCtx,
} from '../lib/automation.ts';
import { editable, traceMarks } from '../lib/automation-flow.ts';
import { dropAutomation, putAutomation, reloadAutomations, useSummaryCtx } from '../lib/automation-store.ts';
import { formatDateTime, formatRelative } from '../lib/format.ts';
import { useLang, useT } from '../lib/i18n.ts';
import { go } from '../lib/router.ts';
import { useCan } from '../lib/session.ts';
import { CheckRow, EnabledSwitch, SourceBadge, StateChip } from './automations.tsx';

export function AutomationDetail({ info }: { info: AutomationInfo }) {
  const t = useT();
  const lang = useLang();
  const ctx = useSummaryCtx();
  const canAdmin = useCan('admin');
  const canControl = useCan('control');
  const [tab, setTab] = useState<'traces' | 'versions'>('traces');
  const [skip, setSkip] = useState(true);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const traces = useTraces(info);

  const draft = isDraftSource(info.createdBy) && !info.enabled;
  const flow = useMemo(() => automationFlow(ctx, info.config), [ctx, info.config]);
  const hooks = webhookIds(info.config);

  const run = () => {
    setRunning(true);
    api.triggerAutomation(info.id, skip).then(
      (res) => {
        setRunning(false);
        if (res.started) toast(t('auto.started'));
        else toast(t('auto.notStarted', { mode: info.mode }), 'error');
        traces.reload(res.runId ?? undefined);
        void reloadAutomations();
      },
      (e: unknown) => (setRunning(false), toast(errorMessage(e), 'error')),
    );
  };

  const remove = () => {
    setDeleting(true);
    api.deleteAutomation(info.id).then(
      () => {
        toast(t('auto.deleted'));
        dropAutomation(info.id);
        go('/automations');
      },
      (e: unknown) => (setDeleting(false), toast(errorMessage(e), 'error')),
    );
  };

  const enable = () => {
    setEnabling(true);
    api.setAutomationEnabled(info.id, true).then(
      (fresh) => (setEnabling(false), putAutomation(fresh)),
      (e: unknown) => (setEnabling(false), toast(errorMessage(e), 'error')),
    );
  };

  return (
    <Card className="flex flex-col gap-5">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-xl leading-tight font-extrabold tracking-[-0.02em] text-balance">{info.alias}</h2>
          <div className="mt-1 font-mono text-xs break-all text-muted">
            automation.{info.id} · mode: {info.mode} · v{info.version}
          </div>
          {info.description && <p className="mt-2 mb-0 text-[13.5px] leading-relaxed text-pretty text-muted">{info.description}</p>}
        </div>
        <label className="flex items-center gap-2.5 rounded-full bg-chip py-1.5 pr-1.5 pl-3 text-xs font-bold">
          {info.enabled ? t('auto.enabled') : t('auto.disabled')}
          <EnabledSwitch info={info} disabled={!canAdmin} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="amber" icon="play" busy={running} disabled={!canControl || !info.valid} onClick={run}>
          {t('auto.run')}
        </Button>
        <CheckRow checked={skip} onChange={setSkip} disabled={!canControl || !info.valid}>
          {t('auto.skipConditions')}
        </CheckRow>
        <span className="hidden flex-1 sm:block" />
        <div className="flex gap-2">
          <Button icon={canAdmin ? 'pencil' : 'code'} onClick={() => go(`/automations/${encodeURIComponent(info.id)}/edit`)}>
            {canAdmin ? t('auto.edit') : t('auto.viewYaml')}
          </Button>
          {canAdmin && <ConfirmButton label={t('common.delete')} confirmLabel={t('common.confirmDelete')} onConfirm={remove} busy={deleting} />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <SourceBadge source={info.createdBy} draft={draft} />
        <span>{info.lastTriggered ? t('auto.lastRun', { t: formatRelative(info.lastTriggered, lang) }) : t('auto.neverRun')}</span>
        {info.running > 0 && (
          <Badge tone="amber" className="px-2! py-0.5! text-[11px]!">
            <Spinner size={11} />
            {t('auto.runningN', { n: info.running })}
          </Badge>
        )}
      </div>

      {draft && (
        <div className="flex flex-col gap-3 rounded-tile bg-amber-soft p-3.5">
          <div className="flex items-start gap-2.5 text-[13.5px] leading-normal">
            <Icon name="bot" size={18} className="mt-px shrink-0" />
            <div>
              <b>{t('auto.draftTitle')}</b> · <span className="font-mono text-xs">{info.createdBy}</span>
              <br />
              {t('auto.draftBody')}
            </div>
          </div>
          {canAdmin && info.valid && (
            <div>
              <Button size="sm" variant="primary" busy={enabling} onClick={enable}>
                {t('auto.reviewEnable')}
              </Button>
            </div>
          )}
        </div>
      )}

      {!info.valid && (
        <div role="alert" className="flex flex-col gap-2 rounded-tile bg-alert-soft p-3.5 text-[13px]">
          <div className="flex items-center gap-2 font-bold text-alert">
            <Icon name="alert" size={16} />
            {t('auto.invalidTitle')}
          </div>
          <ErrorList errors={info.errors} />
        </div>
      )}

      {/* WHEN / IF / THEN */}
      <Flow lines={flow} />

      {hooks.map((id) => (
        <div key={id} className="flex flex-col gap-2 rounded-tile border border-line p-3.5">
          <SectionLabel>{t('auto.webhook')}</SectionLabel>
          <code className="block overflow-x-auto rounded-[10px] bg-chip px-3 py-2 font-mono text-xs break-all">{`${location.origin}/api/webhook/${id}`}</code>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton size="sm" variant="chip" text={`${location.origin}/api/webhook/${id}`} label={t('common.copy')} copiedLabel={t('common.copied')} />
            <span className="text-xs text-muted">{t('auto.webhookHint')}</span>
          </div>
        </div>
      ))}

      <details className="group rounded-tile border border-line">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-[13px] font-bold [&::-webkit-details-marker]:hidden">
          <Icon name="code" size={15} className="text-muted" />
          {t('auto.yaml')}
          <Icon name="chevronDown" size={15} className="ml-auto text-muted transition-transform duration-base group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-2 border-t border-line p-3.5">
          <YamlBlock text={toYaml(info.config)} />
        </div>
      </details>

      {/* traces / versions */}
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <Segmented
          label={t('auto.tab.traces')}
          value={tab}
          onChange={setTab}
          className="self-start"
          size="sm"
          options={[
            { value: 'traces', label: t('auto.tab.traces'), icon: 'activity' },
            { value: 'versions', label: t('auto.tab.versions'), icon: 'history' },
          ]}
        />
        {tab === 'traces' ? <Traces state={traces} config={info.config} ctx={ctx} /> : <Versions info={info} canAdmin={canAdmin} />}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- flow

const pill: Record<FlowKind, string> = {
  when: 'bg-amber text-on-amber',
  if: 'bg-chip text-ink',
  then: 'bg-ink text-bg',
  wait: 'bg-chip text-muted',
};

function Flow({ lines }: { lines: { kind: FlowKind; text: string }[] }) {
  const t = useT();
  if (!lines.length) return null;
  return (
    <div className="flex flex-col" aria-label={t('auto.flow')}>
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[64px_minmax(0,1fr)] items-stretch gap-3">
          <div className="flex flex-col items-center">
            <span className={cx('w-[60px] rounded-lg py-[5px] text-center text-[10.5px] font-extrabold tracking-[0.06em]', pill[l.kind])}>{t(`auto.kind.${l.kind}`)}</span>
            {i < lines.length - 1 && <span className="min-h-3 w-0.5 flex-1 bg-line" />}
          </div>
          <div className={cx('pt-[3px] text-sm leading-[1.45] text-pretty', i < lines.length - 1 ? 'pb-4' : 'pb-0')}>{l.text}</div>
        </div>
      ))}
    </div>
  );
}

export function ErrorList({ errors }: { errors: string[] }) {
  const t = useT();
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {errors.map((e, i) => {
        const { where, message } = humanError(t, e);
        return (
          <li key={i} className="flex items-baseline gap-2 text-[13px] leading-snug">
            <Dot tone="alert" />
            <span className="min-w-0">
              {where && <span className="mr-1.5 font-mono text-xs font-bold">{where}</span>}
              {message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function YamlBlock({ text }: { text: string }) {
  const t = useT();
  return (
    <>
      <pre className="m-0 max-h-[420px] overflow-auto rounded-[12px] bg-chip p-3.5 font-mono text-xs leading-relaxed whitespace-pre">{text}</pre>
      <div>
        <CopyButton size="sm" variant="chip" text={text} label={t('common.copy')} copiedLabel={t('common.copied')} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- traces

interface TraceState {
  list: Trace[] | null;
  error: string | null;
  selected: string | null;
  select: (runId: string) => void;
  reload: (select?: string) => void;
}

/** Loads traces; polls every 2s while a run is in progress, and refreshes whenever the automation fires. */
function useTraces(info: AutomationInfo): TraceState {
  const [list, setList] = useState<Trace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(
    (select?: string) => {
      api.automationTraces(info.id).then(
        (traces) => {
          setList(traces);
          setError(null);
          if (select) setSelected(select);
        },
        (e: unknown) => setError(errorMessage(e)),
      );
    },
    [info.id],
  );

  useEffect(() => reload(), [reload, info.lastTriggered, info.version]);

  const busy = Boolean(list?.some((tr) => tr.state === 'running')) || info.running > 0;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      reload();
      void reloadAutomations();
    }, 2_000);
    return () => clearInterval(timer);
  }, [busy, reload]);

  const effective = selected && list?.some((tr) => tr.runId === selected) ? selected : (list?.[0]?.runId ?? null);
  return { list, error, selected: effective, select: setSelected, reload };
}

const VisualEditor = lazy(() => import('../components/automation/visual-editor.tsx'));

function Traces({ state, config, ctx }: { state: TraceState; config: Record<string, unknown>; ctx: SummaryCtx }) {
  const t = useT();
  const lang = useLang();
  const [view, setView] = useState<'timeline' | 'flow'>('timeline');
  const { list, error, selected, select } = state;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!list)
    return (
      <div className="grid place-items-center py-8 text-muted">
        <Spinner />
      </div>
    );
  if (!list.length) return <div className="py-3 text-[13px] text-muted">{t('auto.noTraces')}</div>;
  const trace = list.find((tr) => tr.runId === selected) ?? list[0]!;
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[250px_minmax(0,1fr)]">
      <div className="lv-scroll-x flex gap-1.5 overflow-x-auto pb-1 xl:max-h-[520px] xl:flex-col xl:overflow-x-hidden xl:overflow-y-auto xl:pb-0" role="listbox" aria-label={t('auto.tab.traces')}>
        {list.map((tr) => {
          const on = tr.runId === trace.runId;
          return (
            <button
              key={tr.runId}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => select(tr.runId)}
              className={cx(
                'flex min-w-[190px] shrink-0 flex-col items-start gap-1 rounded-[12px] border px-3 py-2.5 text-left transition-colors duration-base xl:min-w-0',
                on ? 'border-amber bg-amber-soft/50' : 'border-line bg-transparent hover:bg-surface2',
              )}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <StateChip state={tr.state} />
                <span className="font-mono text-[11px] text-muted">{tr.finishedAt ? formatSpan(tr.finishedAt - tr.startedAt) : '…'}</span>
              </div>
              <span className="text-[12.5px] font-bold">{formatDateTime(tr.startedAt, lang)}</span>
              <span className="w-full truncate text-[11.5px] text-muted">{tr.trigger.description}</span>
            </button>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Segmented
          size="sm"
          label={t('vis.traceView')}
          value={view}
          onChange={setView}
          className="self-start"
          options={[
            { value: 'timeline', label: t('vis.traceTimeline'), icon: 'list' },
            { value: 'flow', label: t('vis.traceFlow'), icon: 'workflow' },
          ]}
        />
        {view === 'timeline' ? (
          <TraceTimeline trace={trace} config={config} ctx={ctx} />
        ) : (
          <Suspense
            fallback={
              <div className="grid place-items-center py-8 text-muted">
                <Spinner />
              </div>
            }
          >
            <TraceFlow trace={trace} config={config} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/** The flow, read-only, with what this run did marked on each node (uses the current version of the automation). */
function TraceFlow({ trace, config }: { trace: Trace; config: Record<string, unknown> }) {
  const t = useT();
  const flow = useMemo(() => editable(config), [config]);
  const marks = useMemo(() => traceMarks(flow, trace), [flow, trace]);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted">{t('vis.traceFlowHint')}</div>
      <VisualEditor config={flow} readOnly compact marks={marks} />
    </div>
  );
}

const HIDDEN_VARS = new Set(['id', 'idx', 'platform', 'description']);

function varText(v: unknown): string {
  if (v && typeof v === 'object' && 'state' in v) return String((v as { state: unknown }).state);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function resultText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  return s === '{}' ? null : s;
}

function TraceTimeline({ trace, config, ctx }: { trace: Trace; config: Record<string, unknown>; ctx: SummaryCtx }) {
  const t = useT();
  const lang = useLang();
  const vars = Object.entries(trace.trigger.vars).filter(([k]) => !HIDDEN_VARS.has(k));
  const label = (path: string, kind: 'condition' | 'action', fallback?: string) => {
    try {
      const node = resolvePath(config, path);
      if (node && typeof node === 'object') return kind === 'condition' ? describeCondition(ctx, node) : describeAction(ctx, node);
    } catch {
      // fall through
    }
    return fallback ?? humanPath(t, path);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-tile bg-surface2 p-3.5 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StateChip state={trace.state} />
          <span className="text-[13px] font-bold">{formatDateTime(trace.startedAt, lang)}</span>
        </div>
        <span className="font-mono text-[11px] text-muted">{trace.runId.slice(0, 8)}</span>
      </div>

      <TimelineSection title={t('auto.trace.trigger')}>
        <TimelineRow tone="amber" text={trace.trigger.description} meta="0 ms" />
        {vars.length > 0 && (
          <dl className="m-0 ml-[18px] grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[10px] bg-surface p-2.5 font-mono text-[11.5px]">
            {vars.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="m-0 truncate" title={varText(v)}>
                  {varText(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </TimelineSection>

      <TimelineSection title={t('auto.trace.conditions')}>
        {trace.conditions.length === 0 ? (
          <div className="text-[12.5px] text-muted">{t('auto.trace.noConditions')}</div>
        ) : (
          trace.conditions.map((c, i) => (
            <div key={i} className="flex items-start gap-2.5 text-[13px]">
              <Icon name={c.result ? 'circleCheck' : 'circleX'} size={16} className={cx('mt-px shrink-0', c.result ? 'text-ok' : 'text-alert')} />
              <div className="min-w-0 flex-1">
                <div className="leading-snug">{label(c.path, 'condition')}</div>
                <div className="truncate font-mono text-[11px] text-muted">{c.path}</div>
              </div>
            </div>
          ))
        )}
      </TimelineSection>

      <TimelineSection title={t('auto.trace.steps')}>
        {trace.steps.length === 0 ? (
          <div className="text-[12.5px] text-muted">{t('auto.trace.noSteps')}</div>
        ) : (
          trace.steps.map((s, i) => {
            const result = resultText(s.result);
            return (
              <div key={i} className="flex flex-col gap-1">
                <TimelineRow
                  tone={s.error ? 'alert' : s.finishedAt ? 'ok' : 'amber'}
                  spinning={!s.finishedAt && trace.state === 'running'}
                  text={s.alias ?? label(s.path, 'action', s.type)}
                  meta={s.finishedAt ? formatSpan(s.finishedAt - s.startedAt) : '…'}
                  sub={`${s.path} · ${s.type}`}
                />
                {result && <div className="ml-[18px] truncate font-mono text-[11px] text-muted" title={result}>→ {result}</div>}
                {s.error && <div className="ml-[18px] text-[12.5px] font-semibold text-alert">{s.error}</div>}
              </div>
            );
          })
        )}
      </TimelineSection>

      <div className="flex flex-col gap-1.5 border-t border-line pt-3 text-[13px]">
        {trace.state === 'running' ? (
          <span className="flex items-center gap-2 text-muted">
            <Spinner size={14} />
            {t('auto.trace.inProgress')}
          </span>
        ) : (
          <span className="text-muted">
            {t('auto.trace.result')}: <b className="text-ink">{t(`auto.state.${trace.state}`)}</b>
            {trace.finishedAt ? ` · ${t('auto.trace.took', { d: formatSpan(trace.finishedAt - trace.startedAt) })}` : ''}
          </span>
        )}
        {trace.stopReason && <span className="text-muted">{t('auto.trace.stopReason', { r: trace.stopReason })}</span>}
        {trace.error && <span className="font-semibold text-alert">{trace.error}</span>}
      </div>
    </div>
  );
}

function TimelineSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel className="text-[11px]!">{title}</SectionLabel>
      {children}
    </div>
  );
}

function TimelineRow({ tone, text, meta, sub, spinning }: { tone: 'ok' | 'alert' | 'amber' | 'muted'; text: string; meta?: string; sub?: string; spinning?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 text-[13px]">
      <span className="mt-[5px] grid w-2 place-items-center">{spinning ? <Spinner size={11} className="text-amber-ink" /> : <Dot tone={tone} />}</span>
      <div className="min-w-0 flex-1">
        <div className="leading-snug text-pretty">{text}</div>
        {sub && <div className="truncate font-mono text-[11px] text-muted">{sub}</div>}
      </div>
      {meta && <span className="shrink-0 font-mono text-xs text-muted">{meta}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- versions

function Versions({ info, canAdmin }: { info: AutomationInfo; canAdmin: boolean }) {
  const t = useT();
  const lang = useLang();
  const [list, setList] = useState<AutomationVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    api.automationVersions(info.id).then(
      (v) => (setList(v), setError(null)),
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [info.id, info.version]);

  const restore = (v: AutomationVersion) => {
    setRestoring(v.version);
    const { id: _id, ...config } = v.config;
    api.updateAutomation(info.id, config).then(
      (fresh) => {
        setRestoring(null);
        putAutomation(fresh);
        toast(t('auto.versions.restored', { n: v.version }));
      },
      (e: unknown) => (setRestoring(null), toast(errorMessage(e), 'error')),
    );
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!list)
    return (
      <div className="grid place-items-center py-8 text-muted">
        <Spinner />
      </div>
    );
  if (!list.length) return <div className="py-3 text-[13px] text-muted">{t('auto.versions.empty')}</div>;
  return (
    <div className="flex flex-col">
      {list.map((v) => {
        const current = v.version === info.version;
        const expanded = open === v.version;
        return (
          <div key={v.version} className="border-t border-line first:border-t-0">
            <div className="flex flex-wrap items-center gap-2.5 py-2.5">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : v.version)}
                className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-0 text-left"
              >
                <Icon name="chevronRight" size={15} className={cx('shrink-0 text-muted transition-transform duration-base', expanded && 'rotate-90')} />
                <span className="font-mono text-[13px] font-bold">v{v.version}</span>
                {current && <Badge tone="ok" className="px-2! py-0.5! text-[11px]!">{t('auto.versions.current')}</Badge>}
                <SourceBadge source={v.source} />
                <span className="text-xs text-muted">{formatDateTime(v.createdAt, lang)}</span>
              </button>
              {canAdmin && !current && (
                <Button size="sm" icon="rotateCcw" busy={restoring === v.version} onClick={() => restore(v)}>
                  {t('auto.versions.restore')}
                </Button>
              )}
            </div>
            {expanded && (
              <div className="flex flex-col gap-2 pb-3">
                <YamlBlock text={toYaml(v.config)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
