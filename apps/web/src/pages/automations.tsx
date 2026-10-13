import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/icons.tsx';
import { toast } from '../components/toast.tsx';
import { Badge, Button, Card, EmptyState, ErrorNote, PageHeader, Spinner, Switch, cx } from '../components/ui.tsx';
import { api, errorMessage, type AutomationInfo, type RunState } from '../lib/api.ts';
import { automationSummary, isDraftSource, type TemplateId } from '../lib/automation.ts';
import { putAutomation, reloadAutomations, useAutomations, useSummaryCtx } from '../lib/automation-store.ts';
import { formatRelative } from '../lib/format.ts';
import { useLang, useT, type MessageKey } from '../lib/i18n.ts';
import { go, useSubPath } from '../lib/router.ts';
import { useCan } from '../lib/session.ts';
import { AutomationDetail } from './automation-detail.tsx';
import { AutomationEditor } from './automation-editor.tsx';

/**
 * `#/automations`            list (+ detail of the first one on wide screens)
 * `#/automations/:id`        detail with traces and versions
 * `#/automations/new`        editor (optionally `?template=motion|sunset|webhook`)
 * `#/automations/:id/edit`   editor for an existing automation
 */
export function AutomationsPage() {
  const sub = useSubPath();
  const key = sub.join('/');

  useEffect(() => {
    void reloadAutomations();
    const timer = setInterval(() => void reloadAutomations(), 5_000);
    return () => clearInterval(timer);
  }, []);

  // Moving between list/detail/editor on phones is a page change: start at the top.
  const mode = sub[0] === 'new' || sub[1] === 'edit' ? 'editor' : sub[0] ? 'detail' : 'list';
  useEffect(() => {
    if (mode === 'editor' || !window.matchMedia('(min-width: 1024px)').matches) window.scrollTo(0, 0);
  }, [key, mode]);

  if (sub[0] === 'new') return <AutomationEditor key="new" />;
  if (sub[0] && sub[1] === 'edit') return <AutomationEditor key={sub[0]} id={sub[0]} />;
  return <Overview selected={sub[0]} />;
}

function Overview({ selected }: { selected?: string }) {
  const t = useT();
  const canAdmin = useCan('admin');
  const { list, error } = useAutomations();
  const current = selected ?? list?.[0]?.id;

  return (
    <>
      <div className={cx(selected && 'hidden lg:block')}>
        <PageHeader
          title={t('auto.title')}
          subtitle={t('auto.subtitle')}
          actions={
            canAdmin && list?.length ? (
              <Button variant="amber" icon="plus" onClick={() => go('/automations/new')}>
                {t('auto.new')}
              </Button>
            ) : undefined
          }
        />
      </div>
      {error && !list && <ErrorNote>{error}</ErrorNote>}
      {list === null && !error ? (
        <div className="grid place-items-center py-16 text-muted">
          <Spinner size={20} />
        </div>
      ) : list?.length === 0 ? (
        <EmptyAutomations canAdmin={canAdmin} />
      ) : list ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <div className={cx('min-w-0 lg:sticky lg:top-8', selected && 'hidden lg:block')}>
            <AutomationList list={list} current={current} canAdmin={canAdmin} />
          </div>
          <div className={cx('min-w-0', !selected && 'hidden lg:block')}>
            {selected && (
              <a href="#/automations" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-muted! no-underline hover:text-ink! lg:hidden">
                <Icon name="chevronLeft" size={16} />
                {t('auto.back')}
              </a>
            )}
            {current && list.some((a) => a.id === current) ? (
              <AutomationDetail key={current} info={list.find((a) => a.id === current)!} />
            ) : (
              <Card>
                <EmptyState icon="workflow" title={t('auto.notFound')}>
                  <Button onClick={() => go('/automations')}>{t('auto.back')}</Button>
                </EmptyState>
              </Card>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- list

function AutomationList({ list, current, canAdmin }: { list: AutomationInfo[]; current?: string; canAdmin: boolean }) {
  return (
    <Card as="div" className="flex flex-col gap-0.5 p-1.5!">
      {list.map((a) => (
        <AutomationRow key={a.id} info={a} active={a.id === current} canAdmin={canAdmin} />
      ))}
    </Card>
  );
}

function AutomationRow({ info, active, canAdmin }: { info: AutomationInfo; active: boolean; canAdmin: boolean }) {
  const t = useT();
  const lang = useLang();
  const ctx = useSummaryCtx();
  const draft = isDraftSource(info.createdBy);
  return (
    <div className={cx('flex items-center gap-3 rounded-[15px] transition-colors duration-base', active ? 'bg-surface2' : 'hover:bg-surface2/60')}>
      <a href={`#/automations/${encodeURIComponent(info.id)}`} aria-current={active ? 'true' : undefined} className="min-w-0 flex-1 p-3 pr-0 text-ink! no-underline">
        <div className="truncate text-[14.5px] font-bold">{info.alias}</div>
        <div className="mt-[3px] line-clamp-2 text-[12.5px] leading-snug text-muted">{automationSummary(ctx, info.config)}</div>
        <div className="mt-[7px] flex flex-wrap items-center gap-1.5">
          {!info.valid && (
            <Badge tone="alert" className="px-2! py-0.5! text-[11px]!">
              <Icon name="alert" size={12} />
              {t('auto.invalid')}
            </Badge>
          )}
          {info.running > 0 && (
            <Badge tone="amber" className="px-2! py-0.5! text-[11px]!">
              <Spinner size={11} />
              {t('auto.running')}
            </Badge>
          )}
          <SourceBadge source={info.createdBy} draft={draft && !info.enabled} />
          <span className="text-[11px] text-muted">{info.lastTriggered ? t('auto.lastRun', { t: formatRelative(info.lastTriggered, lang) }) : t('auto.neverRun')}</span>
        </div>
      </a>
      <div className="pr-3">
        <EnabledSwitch info={info} disabled={!canAdmin} />
      </div>
    </div>
  );
}

export function EnabledSwitch({ info, disabled, size }: { info: AutomationInfo; disabled?: boolean; size?: 'md' | 'lg' }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  return (
    <Switch
      checked={info.enabled}
      pending={pending}
      size={size}
      disabled={disabled || (!info.valid && !info.enabled)}
      label={t('auto.toggle', { name: info.alias })}
      onChange={(next) => {
        setPending(true);
        api.setAutomationEnabled(info.id, next).then(
          (fresh) => (setPending(false), putAutomation(fresh)),
          (e: unknown) => (setPending(false), toast(errorMessage(e), 'error')),
        );
      }}
    />
  );
}

/** "api · CLI", "homeassistant", or the amber "Agent draft" for agent proposals awaiting review. */
export function SourceBadge({ source, draft }: { source: string; draft?: boolean }) {
  const t = useT();
  const i = source.indexOf(':');
  const [kind, name] = i < 0 ? [source, ''] : [source.slice(0, i), source.slice(i + 1)];
  const agent = isDraftSource(source);
  return (
    <Badge tone={agent ? 'amber' : 'chip'} className="max-w-[220px] px-2! py-0.5! text-[11px]!">
      {agent && <Icon name="bot" size={12} />}
      <span className="truncate">{draft ? `${t('auto.draft')} · ${name || kind}` : name ? `${kind} · ${name}` : kind}</span>
    </Badge>
  );
}

const stateTone: Record<RunState, { tone: 'ok' | 'chip' | 'alert' | 'amber'; key: MessageKey }> = {
  running: { tone: 'amber', key: 'auto.state.running' },
  finished: { tone: 'ok', key: 'auto.state.finished' },
  stopped: { tone: 'chip', key: 'auto.state.stopped' },
  error: { tone: 'alert', key: 'auto.state.error' },
  aborted: { tone: 'amber', key: 'auto.state.aborted' },
};

export function StateChip({ state }: { state: RunState }) {
  const t = useT();
  const s = stateTone[state];
  return (
    <Badge tone={s.tone} className={cx('px-2! py-0.5! text-[11px]!', state === 'stopped' && 'text-muted!')}>
      {state === 'running' ? <Spinner size={11} /> : <Icon name={state === 'finished' ? 'check' : state === 'error' ? 'alert' : 'circleX'} size={12} />}
      {t(s.key)}
    </Badge>
  );
}

export function CheckRow({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-[13px] font-semibold select-none', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-amber-ink" />
      {children}
    </label>
  );
}

// ---------------------------------------------------------------- empty state

const templates: { id: TemplateId; icon: IconName; title: MessageKey; body: MessageKey }[] = [
  { id: 'motion', icon: 'motion', title: 'tpl.motion.title', body: 'tpl.motion.body' },
  { id: 'sunset', icon: 'sunset', title: 'tpl.sunset.title', body: 'tpl.sunset.body' },
  { id: 'webhook', icon: 'webhook', title: 'tpl.webhook.title', body: 'tpl.webhook.body' },
];

export function TemplatePicker({ disabled }: { disabled?: boolean }) {
  const t = useT();
  return (
    <div className="grid w-full gap-2.5 sm:grid-cols-3">
      {templates.map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          disabled={disabled}
          onClick={() => go(`/automations/new?template=${tpl.id}`)}
          className="flex flex-col items-start gap-2.5 rounded-tile border-[1.5px] border-line bg-surface p-4 text-left transition-colors duration-base hover:border-amber hover:bg-amber-soft/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="grid size-10 place-items-center rounded-[12px] bg-amber-soft text-amber-ink">
            <Icon name={tpl.icon} size={19} />
          </span>
          <span className="text-[14.5px] font-extrabold">{t(tpl.title)}</span>
          <span className="text-[12.5px] leading-snug text-pretty text-muted">{t(tpl.body)}</span>
        </button>
      ))}
    </div>
  );
}

function EmptyAutomations({ canAdmin }: { canAdmin: boolean }) {
  const t = useT();
  return (
    <Card className="flex flex-col items-center gap-5">
      <EmptyState icon="workflow" title={t('auto.empty.title')} body={t('auto.empty.body')} />
      {canAdmin && (
        <>
          <div className="-mt-6 w-full">
            <div className="mb-2.5 text-xs font-extrabold tracking-[0.06em] text-muted uppercase">{t('auto.templates')}</div>
            <TemplatePicker />
          </div>
          <Button icon="code" onClick={() => go('/automations/new')}>
            {t('auto.blank')}
          </Button>
        </>
      )}
    </Card>
  );
}
