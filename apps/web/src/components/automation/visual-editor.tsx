import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { describeAction, describeCondition, describeTrigger, type SummaryCtx } from '../../lib/automation.ts';
import { kindMeta, PICKER, type PickerItem } from '../../lib/automation-catalog.ts';
import {
  branchesOf,
  duplicateAt,
  errorsByNode,
  getAt,
  insertAt,
  isEnabled,
  isGroup,
  isObj,
  listAt,
  moveAt,
  nodeKind,
  pathKey,
  removeAt,
  samePath,
  setAt,
  toggleEnabled,
  toList,
  repeatMode,
  type Branch,
  type NodeError,
  type NodeKind,
  type Obj,
  type Path,
  type Section,
  type TraceMark,
} from '../../lib/automation-flow.ts';
import { useSummaryCtx } from '../../lib/automation-store.ts';
import { useT, type MessageKey, type Translate } from '../../lib/i18n.ts';
import { Icon, type IconName } from '../icons.tsx';
import { Sheet } from '../sheet.tsx';
import { cx } from '../ui.tsx';
import { Inspector } from './inspector.tsx';

/**
 * Structured flow canvas for HA-style automations: WHEN (any trigger) → ONLY IF (all
 * conditions) → THEN (steps in order), with if/else, choose, repeat, parallel and wait drawn as
 * nested lanes. Every node is a path into the raw config, so the YAML stays the source of truth.
 */

export interface VisualEditorProps {
  /** `editable()` form of the config. */
  config: Obj;
  onChange?: (next: Obj) => void;
  errors?: string[];
  readOnly?: boolean;
  /** Show the alias / mode card (editor) — off for the read-only detail view. */
  settings?: { isNew: boolean; takenIds?: string[] } | null;
  /** Trace overlay: node path key → what happened in the run. */
  marks?: Map<string, TraceMark>;
  /** Compact (detail page): no inspector column, clicks do nothing. */
  compact?: boolean;
}

interface Selection {
  path: Path;
  section: Section;
}

interface PickerState {
  listPath: Path;
  index: number;
  section: Section;
  anchor: DOMRect | null;
}

interface Ctx {
  config: Obj;
  readOnly: boolean;
  compact: boolean;
  selected: Selection | null;
  select: (s: Selection | null) => void;
  update: (fn: (c: Obj) => Obj, select?: Selection | null) => void;
  openPicker: (p: PickerState) => void;
  errors: Map<string, NodeError[]>;
  marks?: Map<string, TraceMark>;
  sum: SummaryCtx;
  t: Translate;
}

const EditorContext = createContext<Ctx | null>(null);
const useEditor = () => useContext(EditorContext)!;

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

export default function VisualEditor({ config, onChange, errors = [], readOnly = false, settings = null, marks, compact = false }: VisualEditorProps) {
  const t = useT();
  const sum = useSummaryCtx();
  const [selected, setSelected] = useState<Selection | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const wide = useMedia('(min-width: 1024px)');
  const byNode = useMemo(() => errorsByNode(errors), [errors]);
  const latest = useRef(config);
  latest.current = config;

  const update = useCallback(
    (fn: (c: Obj) => Obj, select?: Selection | null) => {
      if (readOnly || !onChange) return;
      onChange(fn(latest.current));
      if (select !== undefined) setSelected(select);
    },
    [onChange, readOnly],
  );

  // Selection that no longer points at a node (deleted, YAML edited) is dropped.
  const selectedRaw = selected ? getAt(config, selected.path) : undefined;
  useEffect(() => {
    if (selected && !isObj(selectedRaw)) setSelected(null);
  }, [selected, selectedRaw]);

  const ctx: Ctx = { config, readOnly, compact, selected, select: setSelected, update, openPicker: setPicker, errors: byNode, marks, sum, t };
  const general = byNode.get('') ?? [];

  const inspector =
    selected && isObj(selectedRaw) ? (
      <InspectorFor
        selection={selected}
        raw={selectedRaw}
        onClose={() => setSelected(null)}
        onDelete={() => update((c) => removeAt(c, selected.path), null)}
        onChange={(next) => update((c) => setAt(c, selected.path, next))}
      />
    ) : null;

  return (
    <EditorContext.Provider value={ctx}>
      <div className={cx('grid items-start gap-4', !compact && 'lg:grid-cols-[minmax(0,1fr)_380px]')}>
        <div className="flex min-w-0 flex-col gap-4">
          {settings && <SettingsCard isNew={settings.isNew} errors={general} />}
          <SectionBlock section="trigger" />
          <SectionBlock section="condition" />
          <SectionBlock section="action" />
        </div>
        {!compact &&
          (wide ? (
            <aside className="sticky top-4 flex max-h-[calc(100dvh-32px)] min-w-0 flex-col overflow-y-auto overscroll-contain rounded-card border border-line bg-surface p-4 shadow-card" aria-label={t('vis.inspector')}>
              {inspector ?? <InspectorEmpty />}
            </aside>
          ) : (
            inspector && (
              <Sheet label={t('vis.inspector')} onClose={() => setSelected(null)}>
                {inspector}
              </Sheet>
            )
          ))}
      </div>
      {picker && (
        <NodePicker
          state={picker}
          wide={wide}
          onClose={() => setPicker(null)}
          onPick={(item) => {
            const node = item.create();
            setPicker(null);
            const path = [...picker.listPath, Math.min(picker.index, listAt(latest.current, picker.listPath).length)];
            update((c) => insertAt(c, picker.listPath, picker.index, node), { path, section: picker.section });
          }}
        />
      )}
    </EditorContext.Provider>
  );
}

// ---------------------------------------------------------------- settings

function SettingsCard({ isNew, errors }: { isNew: boolean; errors: NodeError[] }) {
  const { config, update, readOnly, t } = useEditor();
  const set = (key: string, v: unknown) => update((c) => setAt(c, [key], v));
  const mode = typeof config.mode === 'string' ? config.mode : 'single';
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-card">
      <input
        value={typeof config.alias === 'string' ? config.alias : ''}
        onChange={(e) => set('alias', e.target.value)}
        readOnly={readOnly}
        placeholder={t('vis.aliasPlaceholder')}
        aria-label={t('vis.f.name')}
        className="min-h-11 w-full rounded-ctl border border-transparent bg-transparent px-1 text-[20px] font-extrabold tracking-[-0.015em] text-ink outline-none placeholder:text-muted/60 hover:border-line focus:border-amber-ink"
      />
      <textarea
        value={typeof config.description === 'string' ? config.description : ''}
        onChange={(e) => set('description', e.target.value || undefined)}
        readOnly={readOnly}
        rows={1}
        placeholder={t('vis.descPlaceholder')}
        aria-label={t('vis.f.description')}
        className="field-sizing-content min-h-9 w-full resize-none rounded-ctl border border-transparent bg-transparent px-1 py-1.5 text-[13.5px] leading-snug text-muted outline-none placeholder:text-muted/60 hover:border-line focus:border-amber-ink"
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-line pt-3">
        {isNew && (
          <label className="flex items-center gap-2 text-[12.5px] font-bold text-muted">
            ID
            <input
              value={typeof config.id === 'string' ? config.id : ''}
              onChange={(e) => set('id', e.target.value.replace(/[^a-z0-9_]/gi, '_').toLowerCase() || undefined)}
              readOnly={readOnly}
              aria-label="ID"
              className="min-h-8 w-[180px] rounded-[10px] border border-line bg-surface2 px-2.5 font-mono text-[12px] text-ink outline-none focus:border-amber-ink"
            />
          </label>
        )}
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-bold text-muted">{t('vis.f.mode')}</span>
          <select
            value={mode}
            disabled={readOnly}
            onChange={(e) => update((c) => setAt(setAt(c, ['mode'], e.target.value), ['max'], e.target.value === 'queued' || e.target.value === 'parallel' ? c.max : undefined))}
            aria-label={t('vis.f.mode')}
            className="min-h-8 rounded-[10px] border border-line bg-surface2 px-2 text-[12.5px] font-bold text-ink outline-none focus:border-amber-ink"
          >
            {(['single', 'restart', 'queued', 'parallel'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`vis.mode.${m}`)}
              </option>
            ))}
          </select>
        </div>
        {(mode === 'queued' || mode === 'parallel') && (
          <label className="flex items-center gap-2 text-[12.5px] font-bold text-muted">
            {t('vis.f.max')}
            <input
              type="number"
              min={1}
              value={typeof config.max === 'number' ? config.max : ''}
              placeholder="10"
              readOnly={readOnly}
              onChange={(e) => set('max', e.target.value ? Number(e.target.value) : undefined)}
              className="min-h-8 w-16 rounded-[10px] border border-line bg-surface2 px-2 text-[12.5px] text-ink outline-none focus:border-amber-ink"
            />
          </label>
        )}
        <span className="text-xs text-muted">{t(`vis.modeHint.${mode === 'restart' || mode === 'queued' || mode === 'parallel' ? mode : 'single'}`)}</span>
      </div>
      {errors.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 rounded-[12px] bg-alert-soft p-2.5 text-[12.5px] text-alert">
          {errors.map((e, i) => (
            <li key={i}>
              {e.field && <b className="mr-1.5 font-mono text-xs">{e.field}</b>}
              {e.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- sections

const SECTION: Record<Section, { key: string; title: MessageKey; hint: MessageKey; pill: string; add: MessageKey }> = {
  trigger: { key: 'triggers', title: 'vis.when', hint: 'vis.whenHint', pill: 'bg-amber text-on-amber', add: 'vis.addTrigger' },
  condition: { key: 'conditions', title: 'vis.onlyIf', hint: 'vis.onlyIfHint', pill: 'bg-chip text-ink', add: 'vis.addCondition' },
  action: { key: 'actions', title: 'vis.then', hint: 'vis.thenHint', pill: 'bg-ink text-bg', add: 'vis.addAction' },
};

function SectionBlock({ section }: { section: Section }) {
  const { config, t, readOnly } = useEditor();
  const meta = SECTION[section];
  const items = listAt(config, [meta.key]);
  if (readOnly && !items.length && section === 'condition') return null;
  return (
    <section className="flex flex-col gap-3" aria-label={t(meta.title)}>
      <div className="flex items-baseline gap-2.5">
        <span className={cx('rounded-lg px-2.5 py-[5px] text-[11px] font-extrabold tracking-[0.08em]', meta.pill)}>{t(meta.title)}</span>
        <span className="text-[12.5px] text-muted">{t(meta.hint)}</span>
      </div>
      <NodeList section={section} listPath={[meta.key]} emptyLabel={section === 'condition' ? t('vis.noConditions') : undefined} />
    </section>
  );
}

// ---------------------------------------------------------------- lists (with drag to reorder)

const JOINER: Record<Section, MessageKey | null> = { trigger: 'vis.or', condition: 'vis.and', action: null };

function NodeList({ section, listPath, emptyLabel, joiner }: { section: Section; listPath: Path; emptyLabel?: string; joiner?: MessageKey | null }) {
  const { config, readOnly, openPicker, update, t } = useEditor();
  const items = listAt(config, listPath);
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; gap: number } | null>(null);
  const join = joiner === undefined ? JOINER[section] : joiner;
  const meta = SECTION[section];

  const startDrag = (e: ReactPointerEvent<HTMLElement>, from: number) => {
    if (readOnly || items.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let gap = from;
    const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>(':scope > [data-node-row]') ?? [])];
    const move = (ev: PointerEvent) => {
      const rects = rows().map((n) => n.getBoundingClientRect());
      const idx = rects.findIndex((r) => ev.clientY < r.top + r.height / 2);
      gap = idx < 0 ? rects.length : idx;
      setDrag({ from, gap });
    };
    const end = (commit: boolean) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      setDrag(null);
      const to = gap > from ? gap - 1 : gap;
      if (commit && to !== from) update((c) => moveAt(c, listPath, from, to), { path: [...listPath, to], section });
    };
    const up = () => end(true);
    const cancel = () => end(false);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
    setDrag({ from, gap });
  };

  const add = (index: number, el: HTMLElement) => openPicker({ listPath, index, section, anchor: el.getBoundingClientRect() });

  return (
    <div ref={listRef} className="relative flex flex-col">
      {items.length > 0 && <span className="pointer-events-none absolute top-5 bottom-5 left-[19px] w-0.5 bg-line" aria-hidden="true" />}
      {items.length === 0 && emptyLabel && <div className="mb-2 pl-1 text-[12.5px] text-muted">{emptyLabel}</div>}
      {items.map((raw, i) => (
        <div key={i} data-node-row className="relative flex flex-col">
          {drag && drag.gap === i && drag.from !== i && drag.from !== i - 1 && <DropLine />}
          {i > 0 &&
            (join ? (
              <Joiner label={t(join)} />
            ) : (
              <InsertPoint label={t('vis.insertHere')} onClick={(el) => add(i, el)} />
            ))}
          <NodeCard section={section} path={[...listPath, i]} raw={raw} index={i} count={items.length} dragging={drag?.from === i} onGrip={(e) => startDrag(e, i)} />
          {drag && i === items.length - 1 && drag.gap === items.length && drag.from !== i && <DropLine />}
        </div>
      ))}
      {!readOnly && (
        <div className={cx('relative flex items-center', items.length > 0 && 'pt-3')}>
          {items.length > 0 && <span className="pointer-events-none absolute top-0 left-[19px] h-3 w-0.5 bg-line" aria-hidden="true" />}
          <button
            type="button"
            onClick={(e) => add(items.length, e.currentTarget)}
            className="group inline-flex min-h-10 items-center gap-2 rounded-full border border-dashed border-line bg-surface py-1 pr-4 pl-1 text-[13px] font-bold text-muted transition-colors duration-base hover:border-amber hover:text-ink"
          >
            <span className="grid size-[30px] place-items-center rounded-full bg-chip text-ink transition-colors duration-base group-hover:bg-amber group-hover:text-on-amber">
              <Icon name="plus" size={16} />
            </span>
            {t(listPath.length === 1 ? meta.add : section === 'condition' ? 'vis.addCondition' : section === 'trigger' ? 'vis.addTrigger' : 'vis.addStep')}
          </button>
        </div>
      )}
    </div>
  );
}

function DropLine() {
  return <div className="pointer-events-none absolute -top-[5px] right-0 left-0 z-10 h-[3px] rounded-full bg-amber" aria-hidden="true" />;
}

function Joiner({ label }: { label: string }) {
  return (
    <div className="relative flex h-7 items-center">
      <span className="relative z-[1] ml-[7px] rounded-full bg-bg px-1.5 text-[10.5px] font-extrabold tracking-[0.06em] text-muted uppercase">{label}</span>
    </div>
  );
}

function InsertPoint({ label, onClick }: { label: string; onClick: (el: HTMLElement) => void }) {
  const { readOnly } = useEditor();
  if (readOnly) return <div className="h-4" aria-hidden="true" />;
  return (
    <div className="group/ins relative flex h-7 items-center">
      <button
        type="button"
        onClick={(e) => onClick(e.currentTarget)}
        aria-label={label}
        title={label}
        className="relative z-[1] ml-[9px] grid size-[22px] place-items-center rounded-full border border-line bg-surface text-muted opacity-60 transition-[opacity,background-color,color] duration-base group-hover/ins:opacity-100 hover:border-amber hover:bg-amber hover:text-on-amber focus-visible:opacity-100 max-md:opacity-100"
      >
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- nodes

function summarize(sum: SummaryCtx, t: Translate, section: Section, kind: NodeKind, raw: Obj): string {
  const alias = typeof raw.alias === 'string' && raw.alias.trim() ? raw.alias : null;
  if (section === 'trigger') return describeTrigger(sum, raw);
  if (section === 'condition' || kind === 'condition') {
    const k = section === 'condition' ? kind : nodeKind('condition', raw);
    if (isGroup(k)) return alias ?? t(`vis.groupSum.${k as 'and' | 'or' | 'not'}`);
    return alias ?? describeCondition(sum, raw);
  }
  switch (kind) {
    case 'if': {
      const conds = toList(raw.if).filter(isEnabled);
      return alias ?? (conds.length ? t('vis.sum.if', { c: conds.map((c) => describeCondition(sum, c)).join(t('sum.andWord')) }) : t('vis.sum.ifEmpty'));
    }
    case 'choose':
      return alias ?? t('vis.sum.choose', { n: toList(raw.choose).length });
    case 'repeat': {
      const r = isObj(raw.repeat) ? raw.repeat : {};
      const mode = repeatMode(raw);
      if (alias) return alias;
      if (mode === 'count') return t('vis.sum.repeatCount', { n: String(r.count ?? '?') });
      const conds = toList(r[mode]).map((c) => describeCondition(sum, c)).join(t('sum.andWord'));
      return t(mode === 'while' ? 'vis.sum.repeatWhile' : 'vis.sum.repeatUntil', { c: conds || '…' });
    }
    case 'parallel':
      return alias ?? t('vis.sum.parallel', { n: toList(raw.parallel).length });
    case 'sequence':
      return alias ?? t('vis.sum.sequence', { n: toList(raw.sequence).length });
    case 'wait': {
      const timeout = raw.timeout !== undefined ? describeAction(sum, { delay: raw.timeout }) : '';
      return alias ?? (toList(raw.wait_for_trigger).length ? describeAction(sum, raw) : t('vis.sum.waitEmpty') + (timeout ? ` · ${timeout}` : ''));
    }
    case 'unknown':
      return t('vis.sum.unknown', { k: Object.keys(raw).filter((k) => k !== 'alias' && k !== 'enabled').join(', ') || '?' });
  }
  return describeAction(sum, raw);
}

const TILE: Record<Section, string> = {
  trigger: 'bg-amber text-on-amber',
  condition: 'bg-chip text-ink',
  action: 'bg-ink text-bg',
};

const MARK: Record<TraceMark, { ring: string; icon: IconName; tone: string; label: MessageKey }> = {
  ran: { ring: 'border-ok', icon: 'circleCheck', tone: 'text-ok', label: 'vis.mark.ran' },
  passed: { ring: 'border-ok', icon: 'circleCheck', tone: 'text-ok', label: 'vis.mark.passed' },
  failed: { ring: 'border-alert', icon: 'circleX', tone: 'text-alert', label: 'vis.mark.failed' },
  blocked: { ring: 'border-alert', icon: 'circleX', tone: 'text-alert', label: 'vis.mark.blocked' },
};

function NodeCard({ section, path, raw, index, count, dragging, onGrip }: { section: Section; path: Path; raw: unknown; index: number; count: number; dragging: boolean; onGrip: (e: ReactPointerEvent<HTMLElement>) => void }) {
  const ctx = useEditor();
  const { t, sum, selected, select, readOnly, compact, update, errors, marks } = ctx;
  const obj = isObj(raw) ? raw : {};
  const kind = nodeKind(section, raw);
  const tileSection: Section = section === 'action' && kind === 'condition' ? 'condition' : section;
  const meta = kindMeta(section, kind, obj);
  const enabled = isEnabled(raw);
  const key = pathKey(path);
  const errs = errors.get(key) ?? [];
  const nestedErrors = useMemo(() => [...errors.keys()].some((k) => k.startsWith(`${key}/`)), [errors, key]);
  const isSel = samePath(selected?.path, path);
  const mark = marks?.get(key);
  const branches = isObj(raw) ? branchesOf(section, raw, path) : [];
  const listPath = path.slice(0, -1);
  const text = isObj(raw) ? summarize(sum, t, section, kind, obj) : String(raw);

  const onKey = (e: ReactKeyboardEvent) => {
    if (readOnly) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = index + (e.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < count) update((c) => moveAt(c, listPath, index, to), { path: [...listPath, to], section });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.target === e.currentTarget) {
      e.preventDefault();
      update((c) => removeAt(c, path), null);
    }
  };

  return (
    <div
      data-node={key}
      className={cx(
        'relative rounded-card border-[1.5px] bg-surface shadow-card transition-[border-color,opacity,box-shadow] duration-base',
        isSel ? 'border-amber shadow-[0_0_0_3px_var(--amber-soft)]' : mark ? MARK[mark].ring : errs.length ? 'border-alert/60' : 'border-line',
        dragging && 'opacity-50',
        marks && !mark && 'opacity-55',
      )}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={() => !compact && select(isSel ? null : { path, section })}
          onKeyDown={onKey}
          disabled={compact}
          aria-pressed={compact ? undefined : isSel}
          className={cx('flex min-w-0 flex-1 items-start gap-3 rounded-card border-0 bg-transparent p-2 pr-1 text-left text-ink disabled:cursor-default', !enabled && 'opacity-55')}
        >
          <span className={cx('relative z-[1] grid size-[38px] shrink-0 place-items-center rounded-[12px]', TILE[tileSection])}>
            <Icon name={meta.icon} size={17} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-px">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-bold text-muted">
              {t(meta.label)}
              {section === 'trigger' && obj.id !== undefined && <span className="rounded-md bg-chip px-1.5 font-mono text-[10.5px] text-ink">#{String(obj.id)}</span>}
              {!enabled && (
                <span className="inline-flex items-center gap-1 rounded-md bg-chip px-1.5 text-[10.5px]">
                  <Icon name="eyeOff" size={11} />
                  {t('vis.disabled')}
                </span>
              )}
              {mark && (
                <span className={cx('inline-flex items-center gap-1 text-[10.5px]', MARK[mark].tone)}>
                  <Icon name={MARK[mark].icon} size={12} />
                  {t(MARK[mark].label)}
                </span>
              )}
            </span>
            <span className={cx('text-[14px] leading-snug font-bold text-pretty', !enabled && 'line-through decoration-muted/60')}>{text}</span>
            {errs.length > 0 && (
              <span className="mt-0.5 flex items-start gap-1.5 text-[12px] leading-snug font-semibold text-alert">
                <Icon name="alert" size={13} className="mt-px shrink-0" />
                <span>
                  {errs[0]!.field && <span className="font-mono">{errs[0]!.field}: </span>}
                  {errs[0]!.message}
                  {errs.length > 1 && ` (+${errs.length - 1})`}
                </span>
              </span>
            )}
            {!errs.length && nestedErrors && !branches.length && <span className="text-[12px] font-semibold text-alert">{t('vis.nestedErrors')}</span>}
          </span>
        </button>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-0.5 p-1.5 pl-0">
            {count > 1 && (
              <span
                onPointerDown={onGrip}
                role="presentation"
                title={t('vis.dragHint')}
                className="grid size-8 cursor-grab touch-none place-items-center rounded-[9px] text-muted hover:bg-chip hover:text-ink active:cursor-grabbing max-md:hidden"
              >
                <Icon name="grip" size={15} />
              </span>
            )}
            <NodeMenu section={section} path={path} index={index} count={count} enabled={enabled} />
          </div>
        )}
      </div>
      {branches.length > 0 && <Branches section={section} raw={obj} path={path} branches={branches} />}
    </div>
  );
}

// ---------------------------------------------------------------- nested branches

const LANE_PILL: Partial<Record<Branch['role'], string>> = { then: 'bg-ink text-bg', else: 'bg-chip text-ink', default: 'bg-chip text-ink', option: 'bg-ink text-bg', lane: 'bg-ink text-bg', body: 'bg-ink text-bg', wait: 'bg-amber text-on-amber' };

function Branches({ section, raw, path, branches }: { section: Section; raw: Obj; path: Path; branches: Branch[] }) {
  const { t, update, readOnly } = useEditor();
  const kind = nodeKind(section, raw);

  const lane = (b: Branch, title: string, opts: { remove?: () => void; joiner?: MessageKey | null } = {}) => (
    <Lane key={pathKey(b.path)} title={title} pill={b.section === 'condition' ? 'bg-chip text-ink' : (LANE_PILL[b.role] ?? 'bg-chip text-ink')} onRemove={readOnly ? undefined : opts.remove}>
      <NodeList section={b.section} listPath={b.path} joiner={opts.joiner} emptyLabel={readOnly ? t('vis.emptyLane') : undefined} />
    </Lane>
  );

  if (kind === 'if') {
    const [ifB, thenB, elseB] = branches as [Branch, Branch, Branch];
    return (
      <BranchBox>
        {lane(ifB, t('vis.lane.if'))}
        <LaneRow>
          {lane(thenB, t('vis.lane.then'))}
          {elseB.absent ? (
            !readOnly && <AddLane label={t('vis.addElse')} onClick={() => update((c) => setAt(c, [...path, 'else'], []))} />
          ) : (
            lane(elseB, t('vis.lane.else'), { remove: () => update((c) => setAt(c, [...path, 'else'], undefined)) })
          )}
        </LaneRow>
      </BranchBox>
    );
  }
  if (kind === 'choose') {
    const options = toList(raw.choose);
    const def = branches.find((b) => b.role === 'default')!;
    return (
      <BranchBox>
        <LaneRow>
          {options.map((_, i) => {
            const conds = branches.find((b) => b.role === 'option' && b.index === i && b.section === 'condition')!;
            const seq = branches.find((b) => b.role === 'option' && b.index === i && b.section === 'action')!;
            return (
              <Lane key={i} title={t('vis.lane.option', { n: i + 1 })} pill="bg-ink text-bg" onRemove={readOnly || options.length < 2 ? undefined : () => update((c) => removeAt(c, [...path, 'choose', i]))}>
                <SubLabel>{t('vis.lane.when')}</SubLabel>
                <NodeList section="condition" listPath={conds.path} />
                <SubLabel>{t('vis.lane.do')}</SubLabel>
                <NodeList section="action" listPath={seq.path} />
              </Lane>
            );
          })}
          {def.absent ? (
            !readOnly && <AddLane label={t('vis.addDefault')} onClick={() => update((c) => setAt(c, [...path, 'default'], []))} />
          ) : (
            lane(def, t('vis.lane.default'), { remove: () => update((c) => setAt(c, [...path, 'default'], undefined)) })
          )}
        </LaneRow>
        {!readOnly && (
          <div>
            <AddLane label={t('vis.addOption')} inline onClick={() => update((c) => insertAt(c, [...path, 'choose'], options.length, { conditions: [], sequence: [] }))} />
          </div>
        )}
      </BranchBox>
    );
  }
  if (kind === 'parallel') {
    return (
      <BranchBox>
        <LaneRow>
          {branches.map((b, i) => lane(b, t('vis.lane.lane', { n: i + 1 }), { remove: branches.length > 1 ? () => update((c) => removeAt(c, [...path, 'parallel', i])) : undefined }))}
          {!readOnly && <AddLane label={t('vis.addLane')} onClick={() => update((c) => insertAt(c, [...path, 'parallel'], branches.length, { sequence: [] }))} />}
        </LaneRow>
      </BranchBox>
    );
  }
  if (kind === 'repeat') {
    return (
      <BranchBox>
        {branches.map((b) => lane(b, t(b.role === 'while' ? 'vis.lane.while' : b.role === 'until' ? 'vis.lane.until' : 'vis.lane.body')))}
      </BranchBox>
    );
  }
  // wait_for_trigger, sequence, condition groups
  const b = branches[0]!;
  const groupKind = isGroup(kind) ? kind : section === 'action' && kind === 'condition' ? nodeKind('condition', raw) : null;
  const title = b.role === 'wait' ? t('vis.lane.waitFor') : b.role === 'sequence' ? t('vis.lane.steps') : t(`vis.groupLane.${(groupKind ?? 'and') as 'and' | 'or' | 'not'}`);
  const joiner: MessageKey | null | undefined = b.role === 'conditions' ? (groupKind === 'and' ? 'vis.and' : 'vis.or') : undefined;
  return <BranchBox>{lane(b, title, { joiner })}</BranchBox>;
}

function BranchBox({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-2.5 border-t border-dashed border-line px-2 pt-2.5 pb-2.5 md:px-2.5">{children}</div>;
}

function LaneRow({ children }: { children: ReactNode }) {
  const { compact } = useEditor();
  // Side by side on wide canvases; the narrow read-only view (trace column) stacks them.
  return <div className={cx('lv-scroll-x grid min-w-0 gap-2.5', !compact && 'md:auto-cols-[minmax(250px,1fr)] md:grid-flow-col md:overflow-x-auto md:pb-1')}>{children}</div>;
}

function Lane({ title, pill, onRemove, children }: { title: string; pill: string; onRemove?: () => void; children: ReactNode }) {
  const { t } = useEditor();
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-tile border border-line bg-surface2/70 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className={cx('rounded-md px-2 py-[3px] text-[10.5px] font-extrabold tracking-[0.06em] uppercase', pill)}>{title}</span>
        {onRemove && (
          <button type="button" onClick={onRemove} className="grid size-7 place-items-center rounded-[8px] border-0 bg-transparent text-muted hover:bg-chip hover:text-ink" aria-label={t('vis.removeLane', { x: title })} title={t('vis.removeLane', { x: title })}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function SubLabel({ children }: { children: ReactNode }) {
  return <div className="pt-0.5 pl-1 text-[10.5px] font-extrabold tracking-[0.06em] text-muted uppercase">{children}</div>;
}

function AddLane({ label, onClick, inline }: { label: string; onClick: () => void; inline?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex items-center justify-center gap-1.5 rounded-tile border border-dashed border-line bg-transparent text-[12.5px] font-bold text-muted transition-colors duration-base hover:border-amber hover:text-ink',
        inline ? 'min-h-9 px-3' : 'min-h-14 px-3',
      )}
    >
      <Icon name="plus" size={14} />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- node menu

function NodeMenu({ section, path, index, count, enabled }: { section: Section; path: Path; index: number; count: number; enabled: boolean }) {
  const { t, update } = useEditor();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listPath = path.slice(0, -1);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const item = (icon: IconName, label: string, run: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <button
      type="button"
      role="menuitem"
      disabled={opts.disabled}
      onClick={() => {
        setOpen(false);
        run();
      }}
      className={cx('flex min-h-9 w-full items-center gap-2.5 rounded-[9px] border-0 bg-transparent px-2.5 text-left text-[13px] font-bold hover:bg-chip disabled:opacity-40 disabled:hover:bg-transparent', opts.danger ? 'text-alert' : 'text-ink')}
    >
      <Icon name={icon} size={15} />
      {label}
    </button>
  );

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('vis.nodeMenu')}
        className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-muted hover:bg-chip hover:text-ink"
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-30 mt-1 flex w-[200px] animate-fade-in flex-col gap-0.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-sheet">
          {item('copy', t('vis.duplicate'), () => update((c) => duplicateAt(c, path), { path: [...listPath, index + 1], section }))}
          {item(enabled ? 'eyeOff' : 'eye', enabled ? t('vis.disable') : t('vis.enable'), () => update((c) => toggleEnabled(c, path)))}
          {item('chevronUp', t('common.moveUp'), () => update((c) => moveAt(c, listPath, index, index - 1), { path: [...listPath, index - 1], section }), { disabled: index === 0 })}
          {item('chevronDown', t('common.moveDown'), () => update((c) => moveAt(c, listPath, index, index + 1), { path: [...listPath, index + 1], section }), { disabled: index >= count - 1 })}
          <div className="my-0.5 h-px bg-line" />
          {item('trash', t('common.delete'), () => update((c) => removeAt(c, path), null), { danger: true })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- picker

function NodePicker({ state, wide, onClose, onPick }: { state: PickerState; wide: boolean; onClose: () => void; onPick: (item: PickerItem) => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const items = PICKER.filter((p) => p.section === state.section);
  const q = query.trim().toLowerCase();
  const shown = items.filter((p) => !q || t(p.label).toLowerCase().includes(q) || t(p.hint).toLowerCase().includes(q));
  const groups = [...new Set(shown.map((p) => p.group))];
  const title = t(state.section === 'trigger' ? 'vis.addTrigger' : state.section === 'condition' ? 'vis.addCondition' : 'vis.addStep');

  const body = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[16px] font-extrabold">{title}</h3>
        {wide && (
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-full border-0 bg-chip text-muted hover:text-ink" aria-label={t('common.close')}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      {items.length > 6 && (
        <div className="relative">
          <Icon name="search" size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            type="search"
            autoFocus={wide}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]) onPick(shown[0]);
            }}
            placeholder={t('vis.search')}
            aria-label={t('vis.search')}
            className="min-h-10 w-full rounded-[10px] border border-line bg-surface2 pr-3 pl-9 text-[13px] text-ink outline-none placeholder:text-muted focus:border-amber-ink"
          />
        </div>
      )}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain">
        {groups.map((g) => (
          <div key={g} className="flex flex-col gap-1">
            <div className="px-1 text-[11px] font-extrabold tracking-[0.06em] text-muted uppercase">{t(g)}</div>
            <div className="grid gap-1 sm:grid-cols-2">
              {shown
                .filter((p) => p.group === g)
                .map((p) => (
                  <button key={p.id} type="button" onClick={() => onPick(p)} className="flex items-start gap-2.5 rounded-[12px] border-0 bg-transparent p-2 text-left text-ink transition-colors duration-base hover:bg-chip focus-visible:bg-chip">
                    <span className={cx('grid size-9 shrink-0 place-items-center rounded-[10px]', TILE[p.section === 'action' && p.kind === 'condition' ? 'condition' : p.section])}>
                      <Icon name={p.icon} size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-bold">{t(p.label)}</span>
                      <span className="block text-[12px] leading-snug text-pretty text-muted">{t(p.hint)}</span>
                    </span>
                  </button>
                ))}
            </div>
          </div>
        ))}
        {!shown.length && <div className="px-1 py-2 text-[13px] text-muted">{t('vis.noMatch')}</div>}
      </div>
    </div>
  );

  if (!wide) return <Sheet label={title} onClose={onClose}>{body}</Sheet>;
  return <Popover anchor={state.anchor} onClose={onClose} label={title}>{body}</Popover>;
}

/** Fixed popover under (or above) the "+" that opened it. */
function Popover({ anchor, onClose, label, children }: { anchor: DOMRect | null; onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const w = Math.min(560, window.innerWidth - 32);
    const a = anchor ?? new DOMRect(window.innerWidth / 2 - w / 2, 120, w, 0);
    const below = window.innerHeight - a.bottom - 16;
    const above = a.top - 16;
    const h = Math.min(ref.current?.scrollHeight ?? 480, 520);
    const top = below >= Math.min(h, 360) || below >= above ? a.bottom + 8 : Math.max(16, a.top - 8 - Math.min(h, above));
    const left = Math.max(16, Math.min(a.left - 8, window.innerWidth - w - 16));
    setPos({ top, left, maxHeight: Math.max(240, top > a.top ? below : above) });
  }, [anchor]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close.current();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, button:not([aria-label])');
    first?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className="fixed z-50 flex w-[min(560px,calc(100vw-32px))] animate-fade-in flex-col rounded-panel border border-line bg-surface p-4 text-ink shadow-sheet"
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- inspector wiring

function InspectorFor({ selection, raw, onClose, onDelete, onChange }: { selection: Selection; raw: Obj; onClose: () => void; onDelete: () => void; onChange: (v: Obj) => void }) {
  const { config, errors, readOnly, t } = useEditor();
  const kind = nodeKind(selection.section, raw);
  const meta = kindMeta(selection.section, kind, raw);
  return (
    <Inspector
      key={pathKey(selection.path)}
      section={selection.section}
      kind={kind}
      icon={meta.icon}
      label={t(meta.label)}
      raw={raw}
      config={config}
      errors={errors.get(pathKey(selection.path)) ?? []}
      readOnly={readOnly}
      onChange={onChange}
      onDelete={onDelete}
      onClose={onClose}
    />
  );
}

function InspectorEmpty() {
  const { t, errors } = useEditor();
  const count = [...errors.values()].reduce((n, l) => n + l.length, 0);
  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-chip text-muted">
          <Icon name="pointer" size={18} />
        </span>
        <div className="text-[14px] font-bold">{t('vis.inspectorEmpty')}</div>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[12.5px] leading-snug text-pretty text-muted">
        <li className="flex gap-2">
          <Icon name="plus" size={14} className="mt-px shrink-0" />
          {t('vis.tip.add')}
        </li>
        <li className="flex gap-2">
          <Icon name="grip" size={14} className="mt-px shrink-0" />
          {t('vis.tip.drag')}
        </li>
        <li className="flex gap-2">
          <Icon name="code" size={14} className="mt-px shrink-0" />
          {t('vis.tip.yaml')}
        </li>
      </ul>
      {count > 0 && <div className="rounded-[12px] bg-alert-soft px-3 py-2 text-[12.5px] font-bold text-alert">{t('vis.errorsOnCanvas', { n: count })}</div>}
    </div>
  );
}

