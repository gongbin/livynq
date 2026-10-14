import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../components/icons.tsx';
import { Badge, Button, Card, EmptyState, PageHeader, Spinner, cx } from '../components/ui.tsx';
import { errorMessage } from '../lib/api.ts';
import { assistantApi, markSaved, openDraftInEditor, resetConversation, send, stopAssistant, useConversation, type AssistantSettings, type ChatItem } from '../lib/assistant.ts';
import { automationSummary } from '../lib/automation.ts';
import { useSummaryCtx } from '../lib/automation-store.ts';
import { useLang, useT, type MessageKey } from '../lib/i18n.ts';
import { go } from '../lib/router.ts';
import { useCan } from '../lib/session.ts';
import { toast } from '../components/toast.tsx';

const SUGGESTIONS: MessageKey[] = ['asst.s.overview', 'asst.s.lightsOff', 'asst.s.sunset', 'asst.s.why'];

export function AssistantPage() {
  const t = useT();
  const lang = useLang();
  const canAdmin = useCan('admin');
  const { items, busy } = useConversation();
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    assistantApi.settings().then(setSettings, () => setSettings(null));
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [items]);

  const submit = (value = text) => {
    if (!value.trim() || busy) return;
    setText('');
    void send(value, lang);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  if (settings && !settings.configured)
    return (
      <>
        <PageHeader title={t('asst.title')} subtitle={t('asst.subtitle')} />
        <Card>
          <EmptyState icon="sparkles" title={t('asst.setupTitle')} body={canAdmin ? t('asst.setupBody') : t('asst.adminOnly')}>
            {canAdmin && (
              <Button variant="amber" icon="settings" onClick={() => go('/settings')}>
                {t('asst.openSettings')}
              </Button>
            )}
          </EmptyState>
        </Card>
      </>
    );

  return (
    <div className="flex min-h-[calc(100dvh-140px)] flex-col">
      <PageHeader
        title={t('asst.title')}
        subtitle={settings?.model ? t('asst.subtitleModel', { model: settings.model }) : t('asst.subtitle')}
        actions={
          items.length > 0 ? (
            <Button icon="plus" onClick={resetConversation}>
              {t('asst.new')}
            </Button>
          ) : undefined
        }
      />
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-3 pb-4">
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
            <span className="grid size-14 place-items-center rounded-tile bg-amber-soft text-amber-ink">
              <Icon name="sparkles" size={26} />
            </span>
            <p className="m-0 max-w-md text-[14px] leading-relaxed text-pretty text-muted">{t('asst.intro')}</p>
            <div className="flex max-w-xl flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => submit(t(s))} className="rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:border-amber">
                  {t(s)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          items.map((it) => <Item key={it.id} item={it} />)
        )}
        {busy && items.at(-1)?.kind !== 'assistant' && (
          <div className="flex items-center gap-2 px-1 text-[13px] text-muted">
            <Spinner size={13} /> {t('asst.thinking')}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+72px)] z-10 mx-auto w-full max-w-[760px] md:bottom-4">
        <form
          className="flex items-end gap-2 rounded-[20px] border border-line bg-surface p-2 shadow-sheet"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            maxLength={4000}
            placeholder={t('asst.placeholder')}
            aria-label={t('asst.placeholder')}
            className="max-h-40 min-h-11 flex-1 resize-none border-0 bg-transparent px-2.5 py-2.5 text-[15px] leading-snug text-ink outline-none [field-sizing:content] placeholder:text-muted"
          />
          {busy ? (
            <Button variant="primary" icon="stop" onClick={stopAssistant} aria-label={t('asst.stop')} />
          ) : (
            <Button type="submit" variant="amber" icon="arrowUpToLine" disabled={!text.trim()} aria-label={t('asst.send')} />
          )}
        </form>
      </div>
    </div>
  );
}

const ACTIONS = ['turn_on', 'turn_off', 'toggle', 'set_brightness', 'set_color_temperature', 'set_color', 'open', 'close', 'stop', 'set_position', 'set_temperature', 'set_hvac_mode', 'set_fan_speed', 'lock', 'unlock'];

const TOOL_ICONS: Record<string, IconName> = {
  home_overview: 'home',
  list_devices: 'list',
  get_device: 'search',
  get_history: 'activity',
  control_device: 'power',
  get_floorplan: 'map',
  list_automations: 'workflow',
  get_automation: 'workflow',
  get_confirmation: 'shieldAlert',
};

function Item({ item }: { item: ChatItem }) {
  const t = useT();
  if (item.kind === 'user')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[18px] rounded-br-[6px] bg-ink px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap text-bg">{item.text}</div>
      </div>
    );
  if (item.kind === 'assistant')
    return <div className="max-w-[92%] px-1 text-[14.5px] leading-relaxed whitespace-pre-wrap text-ink">{item.text}</div>;
  if (item.kind === 'error')
    return (
      <div className="flex items-start gap-2 rounded-[14px] bg-alert-soft px-3.5 py-2.5 text-[13px] text-alert">
        <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{item.text}</span>
      </div>
    );
  if (item.kind === 'tool' && item.tool) {
    const { name, args, status } = item.tool;
    const target = typeof args.target === 'string' ? args.target : typeof args.room === 'string' ? args.room : typeof args.query === 'string' ? args.query : '';
    const action = typeof args.action === 'string' ? args.action : '';
    const actionLabel = ACTIONS.includes(action) ? t(`asst.action.${action}` as MessageKey) : action;
    const label = name === 'control_device' ? t('asst.tool.control', { action: actionLabel, target }) : t(`asst.tool.${name}` as MessageKey, { target });
    return (
      <div className="flex">
        <span
          className={cx(
            'inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold',
            status === 'error' ? 'bg-alert-soft text-alert' : status === 'pending' ? 'bg-amber-soft text-ink' : 'bg-chip text-muted',
          )}
        >
          {status === 'running' ? <Spinner size={11} /> : <Icon name={status === 'error' ? 'circleX' : status === 'pending' ? 'shieldAlert' : TOOL_ICONS[name] ?? 'check'} size={12} />}
          <span className="truncate">{label}</span>
          {status === 'pending' && <span className="shrink-0">· {t('asst.pending')}</span>}
        </span>
      </div>
    );
  }
  if (item.kind === 'automation' && item.automation) return <AutomationDraft item={item} />;
  return null;
}

function AutomationDraft({ item }: { item: ChatItem }) {
  const t = useT();
  const ctx = useSummaryCtx();
  const canControl = useCan('control');
  const [busy, setBusy] = useState(false);
  const { config, warnings, savedId } = item.automation!;
  const save = async () => {
    setBusy(true);
    try {
      const r = await assistantApi.proposeAutomation(config);
      markSaved(item.id, r.id);
      toast(t('asst.draftSaved'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-3 border-amber/50">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-amber-soft text-amber-ink">
          <Icon name="workflow" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-extrabold">{String(config.alias ?? t('asst.untitled'))}</div>
          <div className="mt-0.5 text-[13px] leading-relaxed text-pretty text-muted">{automationSummary(ctx, config)}</div>
        </div>
        <Badge>{savedId ? t('asst.draftSavedBadge') : t('asst.draftBadge')}</Badge>
      </div>
      {warnings.length > 0 && <div className="text-xs text-muted">{warnings.join(' · ')}</div>}
      <div className="flex flex-wrap gap-2">
        {savedId ? (
          <Button size="sm" icon="chevronRight" onClick={() => go(`/automations/${encodeURIComponent(savedId)}`)}>
            {t('asst.openSaved')}
          </Button>
        ) : (
          <>
            {canControl && (
              <Button size="sm" variant="amber" icon="check" busy={busy} onClick={() => void save()}>
                {t('asst.saveDraft')}
              </Button>
            )}
            <Button size="sm" icon="pencil" onClick={() => openDraftInEditor(config)}>
              {t('asst.openEditor')}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
