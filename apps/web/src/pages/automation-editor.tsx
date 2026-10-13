import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Icon, type IconName } from '../components/icons.tsx';
import { toast } from '../components/toast.tsx';
import { Button, Card, EmptyState, ErrorNote, PageHeader, SectionLabel, Spinner, copyText, cx } from '../components/ui.tsx';
import { ApiError, api, errorMessage, type AutomationInfo, type ValidationResult } from '../lib/api.ts';
import { parseYaml, templateConfig, toYaml, type TemplateId, type YamlResult } from '../lib/automation.ts';
import { putAutomation, reloadAutomations, useAutomations, useSummaryCtx } from '../lib/automation-store.ts';
import { deviceKind, type DeviceKind } from '../lib/devices.ts';
import { useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { go, hashQuery } from '../lib/router.ts';
import { useCan } from '../lib/session.ts';
import { ErrorList } from './automation-detail.tsx';
import { CheckRow } from './automations.tsx';

const TEMPLATE_IDS: TemplateId[] = ['blank', 'motion', 'sunset', 'webhook'];

/** YAML editor for a new (`id` undefined) or existing automation, with live server-side validation. */
export function AutomationEditor({ id }: { id?: string }) {
  const t = useT();
  const canAdmin = useCan('admin');
  const canControl = useCan('control');
  const { ready, status, devices } = useLive();
  const { list } = useAutomations();
  const [info, setInfo] = useState<AutomationInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runAfter, setRunAfter] = useState(false);
  const [startDisabled, setStartDisabled] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Initial text: the stored config (edit) or a template filled with this home's entities (new).
  useEffect(() => {
    if (id) {
      api.automation(id).then(
        (a) => (setInfo(a), setText(toYaml(a.config, true))),
        (e: unknown) => setLoadError(errorMessage(e)),
      );
    }
  }, [id]);
  const devicesKnown = ready || status === 'closed';
  useEffect(() => {
    if (id || text !== null || !devicesKnown || list === null) return;
    const wanted = hashQuery().get('template') as TemplateId | null;
    const tpl = wanted && TEMPLATE_IDS.includes(wanted) ? wanted : 'blank';
    setText(toYaml(templateConfig(tpl, { t, devices, taken: new Set(list.map((a) => a.id)) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, devicesKnown, list === null]);
  useEffect(() => {
    if (list === null) void reloadAutomations();
  }, [list]);

  const { parsed, validation, validating } = useValidation(text, id);
  const readOnly = !canAdmin;
  const back = () => go(id ? `/automations/${encodeURIComponent(id)}` : '/automations');

  const save = () => {
    if (readOnly || saving || text === null) return;
    const result = parseYaml(text);
    if (!result.ok) {
      setSaveError(`${t('auto.editor.parseError')}: ${result.message}`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const request = id ? api.updateAutomation(id, result.value) : api.createAutomation(result.value, startDisabled ? false : undefined);
    request
      .then(async (saved) => {
        putAutomation(saved);
        toast(t('auto.editor.saved', { n: saved.version }));
        if (runAfter && canControl && saved.valid) await api.triggerAutomation(saved.id, true).catch((e: unknown) => toast(errorMessage(e), 'error'));
        void reloadAutomations();
        go(`/automations/${encodeURIComponent(saved.id)}`);
      })
      .catch((e: unknown) => {
        setSaving(false);
        if (e instanceof ApiError && e.status === 409) setSaveError(t('auto.editor.exists', { id: String(result.value.id ?? '') }));
        else setSaveError(errorMessage(e));
      });
  };

  const title = id ? (readOnly ? t('auto.editor.viewTitle', { name: info?.alias ?? id }) : t('auto.editor.editTitle', { name: info?.alias ?? id })) : t('auto.editor.newTitle');

  if (loadError) {
    return (
      <>
        <BackLink id={id} />
        <Card>
          <EmptyState icon="workflow" title={t('auto.notFound')} body={loadError}>
            <Button onClick={() => go('/automations')}>{t('auto.back')}</Button>
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <>
      <BackLink id={id} />
      <PageHeader
        title={title}
        subtitle={id ? <span className="font-mono text-xs">automation.{id}</span> : t('auto.editor.subtitle')}
        actions={
          <>
            <Button onClick={back}>{t('common.cancel')}</Button>
            {!readOnly && (
              <Button variant="primary" icon="check" busy={saving} disabled={text === null || (parsed !== null && !parsed.ok)} onClick={save}>
                {t('common.save')}
              </Button>
            )}
          </>
        }
      />
      {readOnly && (
        <div className="flex items-center gap-2.5 rounded-[14px] bg-chip px-3.5 py-3 text-[13px]">
          <Icon name="lock" size={16} className="shrink-0 text-muted" />
          {t('auto.editor.readOnly')}
        </div>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="flex min-w-0 flex-col gap-3.5 p-3! md:p-4!">
          {text === null ? (
            <div className="grid min-h-[360px] place-items-center text-muted">
              <Spinner size={20} />
            </div>
          ) : (
            <CodeArea
              ref={textarea}
              value={text}
              onChange={setText}
              readOnly={readOnly}
              label={t('auto.editor.label')}
              errorLine={parsed && !parsed.ok ? parsed.line : undefined}
              onSave={save}
            />
          )}
          <ValidationPanel parsed={parsed} validation={validation} validating={validating} />
          {saveError && <ErrorNote>{saveError}</ErrorNote>}
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 border-t border-line pt-3.5">
              {canControl && (
                <CheckRow checked={runAfter} onChange={setRunAfter} disabled={startDisabled}>
                  {t('auto.editor.runAfter')}
                </CheckRow>
              )}
              {!id && (
                <CheckRow checked={startDisabled} onChange={(v) => (setStartDisabled(v), v && setRunAfter(false))}>
                  {t('auto.editor.startDisabled')}
                </CheckRow>
              )}
              <span className="ml-auto hidden text-xs text-muted md:inline">{t('auto.editor.shortcut')}</span>
            </div>
          )}
        </Card>
        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-8">
          <EntityPanel devicesKnown={devicesKnown} />
          <div className="flex items-start gap-2.5 px-1 text-xs leading-relaxed text-pretty text-muted">
            <Icon name="sparkles" size={15} className="mt-px shrink-0" />
            {t('auto.editor.help')}
          </div>
        </div>
      </div>
    </>
  );
}

function BackLink({ id }: { id?: string }) {
  const t = useT();
  return (
    <a
      href={id ? `#/automations/${encodeURIComponent(id)}` : '#/automations'}
      className="-mb-1 inline-flex items-center gap-1 self-start text-sm font-bold text-muted! no-underline hover:text-ink! md:-mb-3"
    >
      <Icon name="chevronLeft" size={16} />
      {t('auto.back')}
    </a>
  );
}

// ---------------------------------------------------------------- validation

/** Parses locally on every change; debounced server validation for well-formed YAML. */
function useValidation(text: string | null, id?: string) {
  const [parsed, setParsed] = useState<YamlResult | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (text === null) return;
    const mine = ++seq.current;
    setValidating(true);
    const timer = setTimeout(() => {
      const result = parseYaml(text);
      setParsed(result);
      if (!result.ok) {
        setValidation(null);
        setValidating(false);
        return;
      }
      // Existing automations keep their id from the URL; the YAML shown omits it.
      const config = id ? { ...result.value, id } : result.value;
      api.validateAutomation(config).then(
        (v) => {
          if (seq.current !== mine) return;
          setValidation(v);
          setValidating(false);
        },
        (e: unknown) => {
          if (seq.current !== mine) return;
          setValidation({ ok: false, errors: [errorMessage(e)] });
          setValidating(false);
        },
      );
    }, 450);
    return () => clearTimeout(timer);
  }, [text, id]);

  return { parsed, validation, validating };
}

function ValidationPanel({ parsed, validation, validating }: { parsed: YamlResult | null; validation: ValidationResult | null; validating: boolean }) {
  const t = useT();
  let tone: 'muted' | 'ok' | 'alert' = 'muted';
  let icon: IconName | null = null;
  let label = t('auto.editor.validating');
  if (!validating && parsed && !parsed.ok) {
    tone = 'alert';
    icon = 'alert';
    label = t('auto.editor.parseError');
  } else if (!validating && validation) {
    tone = validation.ok ? 'ok' : 'alert';
    icon = validation.ok ? 'circleCheck' : 'alert';
    label = validation.ok ? t('auto.editor.valid') : t('auto.editor.errors', { n: validation.errors.length });
  }
  const showErrors = !validating || (validation && !validation.ok);
  return (
    <div className={cx('flex flex-col gap-2.5 rounded-[14px] px-3.5 py-3', tone === 'alert' ? 'bg-alert-soft' : tone === 'ok' ? 'bg-ok-soft' : 'bg-chip')} aria-live="polite">
      <div className={cx('flex items-center gap-2 text-[13px] font-bold', tone === 'alert' && 'text-alert')}>
        {validating || !icon ? <Spinner size={15} className="text-muted" /> : <Icon name={icon} size={16} className={tone === 'ok' ? 'text-ok' : undefined} />}
        {label}
      </div>
      {showErrors && parsed && !parsed.ok && (
        <div className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {parsed.line !== undefined && <b className="mr-1.5">{t('auto.editor.line', { n: parsed.line })}</b>}
          {parsed.message}
        </div>
      )}
      {showErrors && parsed?.ok && validation && !validation.ok && <ErrorList errors={validation.errors} />}
      {!validating && parsed?.ok && validation?.warnings && validation.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs leading-relaxed text-amber-ink">
          {validation.warnings.map((w) => (
            <li key={w} className="font-mono break-words">
              ⚠ {w.replace(/^unknown entity /, `${t('auto.editor.unknownEntity')} `)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- code area

interface CodeAreaProps {
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  label: string;
  errorLine?: number;
  onSave: () => void;
  ref: Ref<HTMLTextAreaElement>;
}

/** A plain textarea with a line-number gutter. Tab / Shift+Tab indent by two spaces; ⌘/Ctrl+S saves. */
function CodeArea({ value, onChange, readOnly, label, errorLine, onSave, ref }: CodeAreaProps) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split('\n').length, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key !== 'Tab' || readOnly || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = el;
    if (!e.shiftKey && start === end) {
      insert(el, '  ', start, end, onChange);
      return;
    }
    // Indent / outdent every line touched by the selection.
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const block = value.slice(lineStart, end);
    const next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
    el.setSelectionRange(lineStart, end);
    insert(el, next, lineStart, end, onChange);
    el.setSelectionRange(lineStart, lineStart + next.length);
  };

  return (
    <div className="flex min-h-[360px] overflow-hidden rounded-[14px] border border-line bg-surface2 focus-within:border-amber-ink lg:h-[calc(100dvh-330px)] lg:min-h-[440px]">
      <div
        ref={gutter}
        aria-hidden="true"
        className="shrink-0 overflow-hidden border-r border-line bg-chip/50 py-3 pr-2.5 pl-3 text-right font-mono text-[12.5px] leading-[1.65] text-muted select-none"
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={cx(errorLine === i + 1 && 'rounded bg-alert-soft font-bold text-alert')}>
            {i + 1}
          </div>
        ))}
        <div className="h-6" />
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        readOnly={readOnly}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        wrap="off"
        className="min-h-[360px] min-w-0 flex-1 resize-none overflow-auto border-0 bg-transparent px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] whitespace-pre text-ink outline-none [tab-size:2] focus-visible:outline-none lg:min-h-0"
        style={{ borderRadius: 0 }}
      />
    </div>
  );
}

/** Inserts text keeping the browser's undo history when possible. */
function insert(el: HTMLTextAreaElement, text: string, start: number, end: number, onChange: (v: string) => void) {
  el.setSelectionRange(start, end);
  // execCommand keeps native undo; fall back to a controlled update where unsupported.
  if (!document.execCommand?.('insertText', false, text)) {
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    onChange(next);
    requestAnimationFrame(() => el.setSelectionRange(start + text.length, start + text.length));
  }
}

// ---------------------------------------------------------------- entities

const kindIcon: Record<DeviceKind, IconName> = {
  light: 'bulb',
  plug: 'plug',
  switch: 'toggle',
  fan: 'fan',
  cover: 'blinds',
  garage: 'garage',
  climate: 'airVent',
  lock: 'lock',
  button: 'circleDot',
  motion: 'motion',
  contact: 'door',
  leak: 'droplet',
  sensor: 'gauge',
};

function EntityPanel({ devicesKnown }: { devicesKnown: boolean }) {
  const t = useT();
  const { devices } = useLive();
  const ctx = useSummaryCtx();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = [...ctx.entities.entries()]
      .map(([entityId, ref]) => ({ entityId, ...ref, kind: devices[ref.deviceId] ? deviceKind(devices[ref.deviceId]!) : ref.kind }))
      .filter((r) => !q || r.entityId.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.roomName ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.roomName ?? t('dev.noRoom');
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [ctx.entities, devices, query, t]);

  return (
    <Card as="div" className="flex flex-col gap-3 p-3.5! md:p-4!">
      <div className="flex flex-col gap-1">
        <SectionLabel>{t('auto.editor.entities')}</SectionLabel>
        <div className="text-xs leading-snug text-muted">{t('auto.editor.entitiesHint')}</div>
      </div>
      <label className="relative">
        <Icon name="search" size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('auto.editor.searchEntities')}
          aria-label={t('auto.editor.searchEntities')}
          className="min-h-10 w-full rounded-ctl border border-line bg-surface pr-3 pl-9 text-[13px] text-ink outline-none placeholder:text-muted focus:border-amber-ink"
        />
      </label>
      <div className="-mx-1 flex max-h-[300px] flex-col gap-3 overflow-y-auto px-1 lg:max-h-[calc(100dvh-360px)]">
        {!devicesKnown ? (
          <div className="grid place-items-center py-6 text-muted">
            <Spinner />
          </div>
        ) : groups.length === 0 ? (
          <div className="py-2 text-[13px] text-muted">{t('auto.editor.noEntities')}</div>
        ) : (
          groups.map(([room, rows]) => (
            <div key={room} className="flex flex-col gap-0.5">
              <div className="px-1 pb-1 text-[11px] font-bold text-muted">{room}</div>
              {rows.map((r) => (
                <button
                  key={r.entityId}
                  type="button"
                  title={r.entityId}
                  onClick={() => void copyText(r.entityId).then((ok) => ok && toast(t('auto.editor.copied', { id: r.entityId })))}
                  className="group flex items-center gap-2.5 rounded-[10px] border-0 bg-transparent px-2 py-1.5 text-left transition-colors duration-base hover:bg-chip"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-chip text-muted group-hover:bg-surface">
                    <Icon name={kindIcon[r.kind]} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-bold">{r.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">{r.entityId}</span>
                  </span>
                  <Icon name="copy" size={13} className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
