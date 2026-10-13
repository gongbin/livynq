import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { stringify } from 'yaml';
import { parseYaml } from '../../lib/automation.ts';
import { ATTRIBUTES, CONTROLLABLE, HVAC_MODES, servicesFor, statesFor, WEEKDAY_KEYS, type ServiceField } from '../../lib/automation-catalog.ts';
import {
  entityList,
  entityValue,
  isEnabled,
  isObj,
  repeatMode,
  setGroupKind,
  setRepeatMode,
  toList,
  triggerIds,
  type NodeError,
  type NodeKind,
  type Obj,
  type Section,
} from '../../lib/automation-flow.ts';
import { useT, type MessageKey } from '../../lib/i18n.ts';
import { useLive } from '../../lib/live.ts';
import { Icon, type IconName } from '../icons.tsx';
import { Button, ErrorNote, Segmented, SelectField, Switch, cx } from '../ui.tsx';
import { Chips, DurationInput, EntityPicker, Field, NumberInput, RangeInput, TextInput, TimeInput, useEntityOptions, type EntityOption } from './fields.tsx';

export interface InspectorProps {
  section: Section;
  kind: NodeKind;
  icon: IconName;
  label: string;
  raw: Obj;
  config: Obj;
  errors: NodeError[];
  readOnly: boolean;
  onChange: (next: Obj) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** Keys that read best first in YAML, in this order; everything else keeps its place. */
const LEAD = ['id', 'alias', 'trigger', 'platform', 'condition', 'action', 'service', 'entity_id', 'target'];

/** Sets or removes (undefined) a key. */
const put = (raw: Obj, key: string, value: unknown): Obj => {
  const next = { ...raw };
  if (value === undefined) delete next[key];
  else next[key] = value;
  if (key in raw || value === undefined) return next;
  const out: Obj = {};
  for (const k of LEAD) if (k in next) out[k] = next[k];
  for (const [k, v] of Object.entries(next)) if (!(k in out)) out[k] = v;
  return out;
};

export function Inspector({ section, kind, icon, label, raw, config, errors, readOnly, onChange, onDelete, onClose }: InspectorProps) {
  const t = useT();
  const enabled = isEnabled(raw);
  const set = (key: string, value: unknown) => onChange(put(raw, key, value));
  const isAction = section === 'action';
  const asCondition = section === 'condition' || kind === 'condition';

  let form: ReactNode = null;
  if (section === 'trigger') form = <TriggerForm kind={kind} raw={raw} onChange={onChange} />;
  else if (asCondition) form = <ConditionForm kind={kind} raw={raw} config={config} onChange={onChange} />;
  else form = <ActionForm kind={kind} raw={raw} onChange={onChange} />;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <span className={cx('grid size-10 shrink-0 place-items-center rounded-[12px]', section === 'trigger' ? 'bg-amber text-on-amber' : asCondition ? 'bg-chip text-ink' : 'bg-ink text-bg')}>
          <Icon name={icon} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-extrabold tracking-[0.06em] text-muted uppercase">{t(section === 'trigger' ? 'vis.when' : asCondition && section === 'condition' ? 'vis.onlyIf' : 'vis.then')}</div>
          <h3 className="m-0 truncate text-[17px] font-extrabold tracking-[-0.01em]">{label}</h3>
        </div>
        <button type="button" onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded-full border-0 bg-chip text-muted hover:text-ink" aria-label={t('common.close')}>
          <Icon name="x" size={17} />
        </button>
      </div>

      {errors.length > 0 && (
        <ErrorNote>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {errors.map((e, i) => (
              <li key={i}>
                {e.field && <b className="mr-1.5 font-mono text-xs">{e.field}</b>}
                {e.message}
              </li>
            ))}
          </ul>
        </ErrorNote>
      )}

      <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
        {form}

        <div className="flex flex-col gap-4 border-t border-line pt-4">
          {section === 'trigger' ? (
            <TextInput label={t('vis.f.triggerId')} hint={t('vis.f.triggerIdHint')} value={raw.id === undefined ? '' : String(raw.id)} onChange={(v) => set('id', v.trim() ? v.trim() : undefined)} mono />
          ) : (
            <TextInput label={t('vis.f.alias')} hint={t('vis.f.aliasHint')} value={typeof raw.alias === 'string' ? raw.alias : ''} onChange={(v) => set('alias', v ? v : undefined)} />
          )}
          <ToggleRow label={t('vis.f.enabled')} hint={t('vis.f.enabledHint')} checked={enabled} onChange={(v) => set('enabled', v ? undefined : false)} />
          {isAction && kind === 'service' && (
            <ToggleRow label={t('vis.f.continueOnError')} hint={t('vis.f.continueOnErrorHint')} checked={raw.continue_on_error === true} onChange={(v) => set('continue_on_error', v ? true : undefined)} />
          )}
        </div>
      </fieldset>

      <NodeYaml raw={raw} readOnly={readOnly} onApply={onChange} open={kind === 'unknown'} />

      {!readOnly && (
        <div>
          <Button variant="danger" icon="trash" size="sm" onClick={onDelete}>
            {t('vis.deleteNode')}
          </Button>
        </div>
      )}
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-bold">{label}</div>
        {hint && <div className="text-xs leading-snug text-pretty text-muted">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[12px] bg-chip px-3 py-2.5 text-[12.5px] leading-snug text-pretty text-muted">
      <Icon name="info" size={15} className="mt-px shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** Raw YAML for the node, editable: anything the forms do not cover. */
function NodeYaml({ raw, readOnly, onApply, open }: { raw: Obj; readOnly: boolean; onApply: (v: Obj) => void; open: boolean }) {
  const t = useT();
  const text = useMemo(() => stringify(raw, { lineWidth: 0, version: '1.1' }), [raw]);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(text);
    setError(null);
  }, [text]);
  const apply = () => {
    const r = parseYaml(draft);
    if (!r.ok) return setError(r.message);
    setError(null);
    onApply(r.value);
  };
  return (
    <details className="group rounded-[14px] border border-line" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-[13px] font-bold text-muted select-none [&::-webkit-details-marker]:hidden">
        <Icon name="code" size={15} />
        {t('vis.nodeYaml')}
        <Icon name="chevronDown" size={15} className="ml-auto transition-transform duration-base group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-2 border-t border-line p-2.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={readOnly}
          spellCheck={false}
          rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
          aria-label={t('vis.nodeYaml')}
          className="w-full resize-y rounded-[10px] border border-line bg-surface2 p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre text-ink outline-none focus:border-amber-ink"
          wrap="off"
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!readOnly && (
          <div>
            <Button size="sm" icon="check" disabled={draft === text} onClick={apply}>
              {t('vis.applyYaml')}
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- shared bits

function useFirstEntity(ids: string[]): EntityOption | undefined {
  const { byId } = useEntityOptions();
  return ids.map((id) => byId.get(id)).find(Boolean);
}

/** Attribute text field with suggestions for the entity's domain. */
function AttributeInput({ raw, ids, onChange, label }: { raw: Obj; ids: string[]; onChange: (v: string | undefined) => void; label?: string }) {
  const t = useT();
  const first = useFirstEntity(ids);
  const domain = first?.domain ?? ids[0]?.split('.')[0] ?? '';
  const list = ATTRIBUTES[domain] ?? [];
  const id = `attrs-${domain}`;
  return (
    <Field label={label ?? t('vis.f.attribute')} hint={t('vis.f.attributeHint')} htmlFor={`${id}-in`}>
      <input
        id={`${id}-in`}
        list={id}
        value={raw.attribute === undefined ? '' : String(raw.attribute)}
        onChange={(e) => onChange(e.target.value.trim() ? e.target.value.trim() : undefined)}
        placeholder={list[0] ?? 'brightness'}
        spellCheck={false}
        autoComplete="off"
        className="min-h-11 w-full rounded-ctl border border-line bg-surface px-3.5 font-mono text-[13px] text-ink outline-none placeholder:text-muted focus:border-amber-ink"
      />
      <datalist id={id}>
        {list.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
    </Field>
  );
}

/** State choices for the entities' domain, plus a free-text fallback. */
function StatePicker({ label, ids, value, onChange, multi, anyLabel }: { label: string; ids: string[]; value: unknown; onChange: (v: unknown) => void; multi?: boolean; anyLabel?: string }) {
  const t = useT();
  const first = useFirstEntity(ids);
  const domain = first?.domain ?? ids[0]?.split('.')[0] ?? '';
  const options = statesFor(domain, first?.kind);
  const current = toList(value).filter((v) => v !== null).map(String);
  if (!options.length) {
    return (
      <TextInput
        label={label}
        hint={anyLabel ? t('vis.f.stateFreeAny') : t('vis.f.stateFree')}
        value={current.join(', ')}
        onChange={(v) => {
          const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
          onChange(parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : parts);
        }}
      />
    );
  }
  const opts = options.map((o) => ({ value: o.value, label: t(o.label) }));
  const custom = current.filter((c) => !options.some((o) => o.value === c));
  return (
    <div className="flex flex-col gap-1.5">
      <Chips
        label={label}
        multi={multi}
        options={[...(anyLabel ? [{ value: '__any', label: anyLabel }] : []), ...opts, ...custom.map((c) => ({ value: c, label: c }))]}
        value={current.length ? current : anyLabel ? ['__any'] : []}
        onChange={(vals) => {
          const next = vals.filter((v) => v !== '__any');
          if (!multi && vals.includes('__any') && !current.length) return;
          onChange(next.length === 0 ? undefined : next.length === 1 ? next[0] : next);
        }}
      />
    </div>
  );
}

/** Offsets for sun triggers / conditions: before or after, plus a duration. */
function OffsetInput({ label, value, onChange }: { label: string; value: unknown; onChange: (v: string | undefined) => void }) {
  const t = useT();
  const s = value === undefined || value === null ? '' : String(value).trim();
  const negative = s.startsWith('-') || (typeof value === 'number' && value < 0);
  const magnitude = typeof value === 'number' ? Math.abs(value) : s.replace(/^-/, '');
  const write = (neg: boolean, mag: string | undefined) => onChange(mag === undefined || /^0?0:00:00$/.test(mag) ? undefined : `${neg ? '-' : ''}${mag}`);
  return (
    <div className="flex flex-col gap-2">
      <DurationInput label={label} value={magnitude === '' ? undefined : magnitude} onChange={(m) => write(negative, m)} />
      <Segmented
        size="sm"
        label={label}
        value={negative ? 'before' : 'after'}
        onChange={(v) => write(v === 'before', magnitude === '' ? undefined : String(magnitude))}
        options={[
          { value: 'before', label: t('vis.f.earlier') },
          { value: 'after', label: t('vis.f.later') },
        ]}
      />
    </div>
  );
}

const entityFilter = (o: EntityOption) => o.domain !== 'automation';
const numericFilter = (o: EntityOption) => o.domain === 'sensor' || o.domain === 'climate' || o.domain === 'cover' || o.domain === 'light' || o.domain === 'fan' || o.domain === 'switch';

function useUnit(ids: string[], raw: Obj): string | undefined {
  const first = useFirstEntity(ids);
  if (raw.attribute !== undefined) return undefined;
  return first?.unit;
}

// ---------------------------------------------------------------- triggers

function TriggerForm({ kind, raw, onChange }: { kind: NodeKind; raw: Obj; onChange: (v: Obj) => void }) {
  const t = useT();
  const set = (key: string, value: unknown) => onChange(put(raw, key, value));
  const ids = entityList(raw.entity_id);
  switch (kind) {
    case 'state':
      return (
        <>
          <EntityPicker label={t('vis.f.entity')} value={ids} onChange={(v) => set('entity_id', entityValue(v))} filter={entityFilter} />
          <StatePicker label={t('vis.f.to')} ids={ids} value={raw.to} onChange={(v) => set('to', v)} anyLabel={t('vis.f.anyChange')} />
          <DurationInput label={t('vis.f.for')} hint={t('vis.f.forHint')} value={raw.for} onChange={(v) => set('for', v)} />
          <Advanced>
            <StatePicker label={t('vis.f.from')} ids={ids} value={raw.from} onChange={(v) => set('from', v)} anyLabel={t('vis.f.anyState')} />
            <AttributeInput raw={raw} ids={ids} onChange={(v) => set('attribute', v)} />
          </Advanced>
        </>
      );
    case 'numeric_state':
      return <NumericFields raw={raw} onChange={onChange} withFor />;
    case 'time': {
      const at = toList(raw.at);
      return (
        <div className="flex flex-col gap-3">
          {at.map((v, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TimeInput label={at.length > 1 ? t('vis.f.atN', { n: i + 1 }) : t('vis.f.at')} value={v} onChange={(nv) => set('at', at.length === 1 ? nv : at.map((x, j) => (j === i ? nv : x)).filter((x) => x !== undefined))} />
              </div>
              {at.length > 1 && (
                <button type="button" onClick={() => set('at', at.filter((_, j) => j !== i))} className="grid size-11 shrink-0 place-items-center rounded-ctl border-0 bg-chip text-muted hover:text-ink" aria-label={t('common.delete')}>
                  <Icon name="trash" size={15} />
                </button>
              )}
            </div>
          ))}
          <div>
            <Button size="sm" icon="plus" onClick={() => set('at', [...at, '12:00:00'])}>
              {t('vis.f.addTime')}
            </Button>
          </div>
        </div>
      );
    }
    case 'time_pattern': {
      const presets: { label: MessageKey; vars: Record<string, string | number>; v: Obj }[] = [
        { label: 'vis.f.everyMin', vars: { n: 5 }, v: { minutes: '/5' } },
        { label: 'vis.f.everyMin', vars: { n: 15 }, v: { minutes: '/15' } },
        { label: 'vis.f.everyHour', vars: {}, v: { minutes: '0' } },
        { label: 'vis.f.everyHours', vars: { n: 2 }, v: { hours: '/2', minutes: '0' } },
      ];
      const strip = (o: Obj) => {
        const out = { ...o };
        delete out.hours;
        delete out.minutes;
        delete out.seconds;
        return out;
      };
      return (
        <>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p, i) => (
              <button key={i} type="button" onClick={() => onChange({ ...strip(raw), ...p.v })} className="min-h-9 rounded-full border border-line bg-surface px-3 text-[13px] font-bold text-muted hover:border-amber hover:text-ink">
                {t(p.label, p.vars)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(['hours', 'minutes', 'seconds'] as const).map((k) => (
              <TextInput key={k} label={t(`vis.f.${k}`)} value={raw[k] === undefined ? '' : String(raw[k])} onChange={(v) => set(k, v.trim() ? v.trim() : undefined)} placeholder="*" mono />
            ))}
          </div>
          <Hint>{t('vis.f.patternHint')}</Hint>
        </>
      );
    }
    case 'sun':
      return (
        <>
          <Segmented
            label={t('vis.k.t.sun')}
            value={raw.event === 'sunrise' ? 'sunrise' : 'sunset'}
            onChange={(v) => set('event', v)}
            options={[
              { value: 'sunrise', label: t('vis.f.sunrise'), icon: 'sun' },
              { value: 'sunset', label: t('vis.f.sunset'), icon: 'sunset' },
            ]}
          />
          <OffsetInput label={t('vis.f.offset')} value={raw.offset} onChange={(v) => set('offset', v)} />
        </>
      );
    case 'start':
      return (
        <Segmented
          label={t('vis.k.t.start')}
          value={raw.event === 'shutdown' ? 'shutdown' : 'start'}
          onChange={(v) => set('event', v)}
          options={[
            { value: 'start', label: t('vis.f.hubStart'), icon: 'power' },
            { value: 'shutdown', label: t('vis.f.hubStop'), icon: 'stop' },
          ]}
        />
      );
    case 'webhook': {
      const methods = toList(raw.allowed_methods ?? ['POST', 'PUT']).map((m) => String(m).toUpperCase());
      const id = typeof raw.webhook_id === 'string' ? raw.webhook_id : '';
      return (
        <>
          <TextInput label={t('vis.f.webhookId')} value={id} onChange={(v) => set('webhook_id', v.trim())} mono hint={t('vis.f.webhookIdHint')} />
          {id && <code className="block overflow-x-auto rounded-[10px] bg-chip px-3 py-2 font-mono text-xs break-all">{`POST ${location.origin}/api/webhook/${id}`}</code>}
          <Chips label={t('vis.f.methods')} multi options={['POST', 'PUT', 'GET', 'HEAD'].map((m) => ({ value: m, label: m }))} value={methods} onChange={(v) => set('allowed_methods', v.length ? v : undefined)} />
          <ToggleRow label={t('vis.f.localOnly')} hint={t('vis.f.localOnlyHint')} checked={raw.local_only !== false} onChange={(v) => set('local_only', v)} />
        </>
      );
    }
  }
  return <Hint>{t('vis.unsupportedHint')}</Hint>;
}

function Advanced({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <details className="group rounded-[14px] border border-line px-3.5 py-2.5 [&[open]]:pb-3.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[13px] font-bold text-muted select-none [&::-webkit-details-marker]:hidden">
        {t('vis.more')}
        <Icon name="chevronDown" size={15} className="transition-transform duration-base group-open:rotate-180" />
      </summary>
      <div className="mt-3 flex flex-col gap-4">{children}</div>
    </details>
  );
}

function NumericFields({ raw, onChange, withFor }: { raw: Obj; onChange: (v: Obj) => void; withFor?: boolean }) {
  const t = useT();
  const set = (key: string, value: unknown) => onChange(put(raw, key, value));
  const ids = entityList(raw.entity_id);
  const unit = useUnit(ids, raw);
  return (
    <>
      <EntityPicker label={t('vis.f.entity')} value={ids} onChange={(v) => set('entity_id', entityValue(v))} filter={numericFilter} />
      <AttributeInput raw={raw} ids={ids} onChange={(v) => set('attribute', v)} label={t('vis.f.attributeOptional')} />
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label={t('vis.f.above')} value={raw.above} onChange={(v) => set('above', v)} unit={unit} />
        <NumberInput label={t('vis.f.below')} value={raw.below} onChange={(v) => set('below', v)} unit={unit} />
      </div>
      <Hint>{t('vis.f.numericHint')}</Hint>
      {withFor && <DurationInput label={t('vis.f.for')} hint={t('vis.f.forHint')} value={raw.for} onChange={(v) => set('for', v)} />}
    </>
  );
}

// ---------------------------------------------------------------- conditions

function ConditionForm({ kind, raw, config, onChange }: { kind: NodeKind; raw: Obj; config: Obj; onChange: (v: Obj) => void }) {
  const t = useT();
  const set = (key: string, value: unknown) => onChange(put(raw, key, value));
  const ids = entityList(raw.entity_id);
  const condKind = kind === 'condition' ? String(raw.condition ?? (raw.and !== undefined ? 'and' : raw.or !== undefined ? 'or' : raw.not !== undefined ? 'not' : '')) : kind;
  switch (condKind) {
    case 'state':
      return (
        <>
          <EntityPicker label={t('vis.f.entity')} value={ids} onChange={(v) => set('entity_id', entityValue(v))} filter={entityFilter} />
          <StatePicker label={t('vis.f.isState')} ids={ids} value={raw.state} onChange={(v) => set('state', v)} multi />
          <DurationInput label={t('vis.f.forAtLeast')} value={raw.for} onChange={(v) => set('for', v)} />
          {ids.length > 1 && (
            <Segmented
              size="sm"
              label={t('vis.f.match')}
              value={raw.match === 'any' ? 'any' : 'all'}
              onChange={(v) => set('match', v === 'any' ? 'any' : undefined)}
              options={[
                { value: 'all', label: t('vis.f.matchAll') },
                { value: 'any', label: t('vis.f.matchAny') },
              ]}
            />
          )}
          <Advanced>
            <AttributeInput raw={raw} ids={ids} onChange={(v) => set('attribute', v)} />
          </Advanced>
        </>
      );
    case 'numeric_state':
      return <NumericFields raw={raw} onChange={onChange} />;
    case 'time': {
      const days = toList(raw.weekday).map(String);
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TimeInput label={t('vis.f.after')} value={raw.after} onChange={(v) => set('after', v)} optional />
            <TimeInput label={t('vis.f.before')} value={raw.before} onChange={(v) => set('before', v)} optional />
          </div>
          <Hint>{t('vis.f.timeHint')}</Hint>
          <Chips
            label={t('vis.f.weekdays')}
            multi
            options={WEEKDAY_KEYS.map((d) => ({ value: d, label: t(`vis.wd.${d}`) }))}
            value={days}
            onChange={(v) => set('weekday', v.length ? WEEKDAY_KEYS.filter((d) => v.includes(d)) : undefined)}
          />
        </>
      );
    }
    case 'sun': {
      const side = (k: 'after' | 'before') => (
        <div className="flex flex-col gap-3 rounded-[14px] border border-line p-3">
          <Segmented
            size="sm"
            label={t(k === 'after' ? 'vis.f.after' : 'vis.f.before')}
            value={raw[k] === 'sunrise' ? 'sunrise' : raw[k] === 'sunset' ? 'sunset' : 'none'}
            onChange={(v) => onChange(put(put(raw, k, v === 'none' ? undefined : v), `${k}_offset`, v === 'none' ? undefined : raw[`${k}_offset`]))}
            options={[
              { value: 'none', label: t('common.none') },
              { value: 'sunrise', label: t(k === 'after' ? 'vis.f.afterSunrise' : 'vis.f.beforeSunrise') },
              { value: 'sunset', label: t(k === 'after' ? 'vis.f.afterSunset' : 'vis.f.beforeSunset') },
            ]}
          />
          {raw[k] !== undefined && <OffsetInput label={t('vis.f.offset')} value={raw[`${k}_offset`]} onChange={(v) => set(`${k}_offset`, v)} />}
        </div>
      );
      return (
        <>
          {side('after')}
          {side('before')}
          <Hint>{t('vis.f.sunHint')}</Hint>
        </>
      );
    }
    case 'and':
    case 'or':
    case 'not':
      return (
        <>
          <Segmented
            label={t('vis.f.groupKind')}
            value={condKind}
            onChange={(v) => onChange(setGroupKind(raw, v))}
            options={[
              { value: 'and', label: t('vis.group.and') },
              { value: 'or', label: t('vis.group.or') },
              { value: 'not', label: t('vis.group.not') },
            ]}
          />
          <Hint>{t('vis.f.groupHint')}</Hint>
        </>
      );
    case 'trigger': {
      const all = triggerIds(config);
      const chosen = toList(raw.id).map(String).filter(Boolean);
      return all.length ? (
        <Chips label={t('vis.f.triggeredBy')} multi options={all.map((id) => ({ value: id, label: id }))} value={chosen} onChange={(v) => set('id', v.length === 1 ? v[0] : v.length ? v : '')} />
      ) : (
        <Hint>{t('vis.f.noTriggerIds')}</Hint>
      );
    }
  }
  return <Hint>{t('vis.unsupportedHint')}</Hint>;
}

// ---------------------------------------------------------------- actions

/** Entity ids from wherever HA allows them: `target`, top-level `entity_id` or `data.entity_id`. */
function targetIds(raw: Obj): string[] {
  const target = isObj(raw.target) ? raw.target : {};
  return entityList(target.entity_id ?? raw.entity_id ?? (isObj(raw.data) ? raw.data.entity_id : undefined));
}

function withTarget(raw: Obj, key: 'entity_id' | 'area_id', ids: string[]): Obj {
  const out = { ...raw };
  delete out.entity_id;
  if (isObj(out.data) && out.data.entity_id !== undefined) {
    const data = { ...out.data };
    delete data.entity_id;
    if (Object.keys(data).length) out.data = data;
    else delete out.data;
  }
  const target: Obj = isObj(raw.target) ? { ...raw.target } : {};
  delete target.entity_id;
  delete target.area_id;
  const v = entityValue(ids);
  if (v !== undefined) target[key] = v;
  out.target = target;
  return out;
}

function ActionForm({ kind, raw, onChange }: { kind: NodeKind; raw: Obj; onChange: (v: Obj) => void }) {
  const t = useT();
  const set = (key: string, value: unknown) => onChange(put(raw, key, value));
  switch (kind) {
    case 'service':
      return /^notify\./.test(String(raw.action ?? raw.service ?? '')) ? <NotifyForm raw={raw} onChange={onChange} /> : <ServiceForm raw={raw} onChange={onChange} />;
    case 'delay':
      return <DurationInput label={t('vis.f.delay')} value={raw.delay} onChange={(v) => set('delay', v ?? '00:00:00')} allowEmpty={false} />;
    case 'wait':
      return (
        <>
          <Hint>{t('vis.f.waitHint')}</Hint>
          <DurationInput label={t('vis.f.timeout')} hint={t('vis.f.timeoutHint')} value={raw.timeout} onChange={(v) => set('timeout', v)} />
          {raw.timeout !== undefined && (
            <ToggleRow label={t('vis.f.continueOnTimeout')} hint={t('vis.f.continueOnTimeoutHint')} checked={raw.continue_on_timeout !== false} onChange={(v) => set('continue_on_timeout', v ? undefined : false)} />
          )}
        </>
      );
    case 'if':
      return (
        <>
          <Hint>{t('vis.f.ifHint')}</Hint>
          <ToggleRow label={t('vis.f.hasElse')} checked={raw.else !== undefined} onChange={(v) => set('else', v ? toList(raw.else) : undefined)} />
        </>
      );
    case 'choose': {
      const options = toList(raw.choose);
      return (
        <>
          <Hint>{t('vis.f.chooseHint')}</Hint>
          <div>
            <Button size="sm" icon="plus" onClick={() => set('choose', [...options, { conditions: [], sequence: [] }])}>
              {t('vis.addOption')}
            </Button>
          </div>
          <ToggleRow label={t('vis.f.hasDefault')} checked={raw.default !== undefined} onChange={(v) => set('default', v ? toList(raw.default) : undefined)} />
        </>
      );
    }
    case 'repeat': {
      const mode = repeatMode(raw);
      const r = isObj(raw.repeat) ? raw.repeat : {};
      return (
        <>
          <Segmented
            label={t('vis.f.repeatMode')}
            value={mode}
            onChange={(v) => onChange(setRepeatMode(raw, v))}
            options={[
              { value: 'count', label: t('vis.f.repeatCount') },
              { value: 'while', label: t('vis.f.repeatWhile') },
              { value: 'until', label: t('vis.f.repeatUntil') },
            ]}
          />
          {mode === 'count' ? (
            <NumberInput label={t('vis.f.times')} value={r.count} min={1} step={1} onChange={(v) => onChange({ ...raw, repeat: { ...r, count: v ?? 1 } })} />
          ) : (
            <Hint>{t(mode === 'while' ? 'vis.f.whileHint' : 'vis.f.untilHint')}</Hint>
          )}
        </>
      );
    }
    case 'parallel':
      return (
        <>
          <Hint>{t('vis.f.parallelHint')}</Hint>
          <div>
            <Button size="sm" icon="plus" onClick={() => set('parallel', [...toList(raw.parallel), { sequence: [] }])}>
              {t('vis.addLane')}
            </Button>
          </div>
        </>
      );
    case 'sequence':
      return <Hint>{t('vis.f.sequenceHint')}</Hint>;
    case 'stop':
      return (
        <>
          <TextInput label={t('vis.f.stopReason')} value={raw.stop === undefined ? '' : String(raw.stop)} onChange={(v) => set('stop', v)} />
          <ToggleRow label={t('vis.f.stopError')} hint={t('vis.f.stopErrorHint')} checked={raw.error === true} onChange={(v) => set('error', v ? true : undefined)} />
        </>
      );
  }
  return <Hint>{t('vis.unsupportedHint')}</Hint>;
}

/** notify.notify: goes to every phone / browser that turned on notifications. */
function NotifyForm({ raw, onChange }: { raw: Obj; onChange: (v: Obj) => void }) {
  const t = useT();
  const data = isObj(raw.data) ? raw.data : {};
  const extra = isObj(data.data) ? data.data : {};
  const setData = (key: string, v: string) => onChange(put(raw, 'data', put(data, key, v || undefined)));
  const setUrl = (v: string) => {
    const next = put(extra, 'url', v || undefined);
    onChange(put(raw, 'data', put(data, 'data', Object.keys(next).length ? next : undefined)));
  };
  return (
    <>
      <Hint>{t('vis.f.notifyHint')}</Hint>
      <TextInput label={t('vis.f.notifyTitle')} value={String(data.title ?? '')} onChange={(v) => setData('title', v)} placeholder="Livynq" />
      <TextInput label={t('vis.f.notifyMessage')} value={String(data.message ?? '')} onChange={(v) => setData('message', v)} placeholder={t('vis.f.notifyMessagePh')} />
      <TextInput label={t('vis.f.notifyUrl')} hint={t('vis.f.notifyUrlHint')} value={String(extra.url ?? '')} onChange={setUrl} placeholder="/#/devices" mono />
    </>
  );
}

function ServiceForm({ raw, onChange }: { raw: Obj; onChange: (v: Obj) => void }) {
  const t = useT();
  const { rooms } = useLive();
  const { byId } = useEntityOptions();
  const name = String(raw.action ?? raw.service ?? '');
  const [domain = '', service = ''] = name.split('.');
  const isAutomation = domain === 'automation';
  const target = isObj(raw.target) ? raw.target : {};
  const areas = entityList(target.area_id);
  const ids = targetIds(raw);
  const [mode, setMode] = useState<'entities' | 'rooms'>(areas.length && !ids.length ? 'rooms' : 'entities');

  const domains = mode === 'rooms' ? ['homeassistant'] : ids.map((id) => byId.get(id)?.domain ?? id.split('.')[0] ?? '');
  const { domain: svcDomain, defs } = isAutomation ? { domain: 'automation', defs: servicesFor(['automation']).defs } : servicesFor(domains.length ? domains : [domain || 'homeassistant']);
  const def = defs.find((d) => d.service === service && svcDomain === domain) ?? defs.find((d) => d.service === service);
  const data = isObj(raw.data) ? raw.data : {};

  /** Writes the action name; drops data keys the new service does not use. */
  const writeName = (base: Obj, dom: string, svc: string) => {
    const out: Obj = { ...base, action: `${dom}.${svc}` };
    delete out.service;
    const fields = servicesFor([dom]).defs.find((d) => d.service === svc)?.fields ?? [];
    if (isObj(out.data)) {
      const known = new Set(defs.flatMap((d) => d.fields ?? []).map((f) => f.key));
      const kept = Object.fromEntries(Object.entries(out.data).filter(([k]) => !known.has(k) || fields.some((f) => f.key === k)));
      if (Object.keys(kept).length) out.data = kept;
      else delete out.data;
    }
    return out;
  };

  const setTargets = (key: 'entity_id' | 'area_id', next: string[]) => {
    let out = withTarget(raw, key, next);
    if (key === 'entity_id' && !isAutomation) {
      const nd = servicesFor(next.map((id) => byId.get(id)?.domain ?? id.split('.')[0] ?? ''));
      const svc = nd.defs.some((d) => d.service === service) ? service : nd.defs[0]!.service;
      out = writeName(out, next.length ? nd.domain : 'homeassistant', svc);
    } else if (key === 'area_id') out = writeName(out, 'homeassistant', ['turn_on', 'turn_off', 'toggle'].includes(service) ? service : 'turn_on');
    onChange(out);
  };

  const setField = (f: ServiceField, v: unknown) => {
    const next = put(data, f.key, v);
    onChange(put(raw, 'data', Object.keys(next).length ? next : undefined));
  };

  return (
    <>
      {!isAutomation && (
        <Segmented
          size="sm"
          label={t('vis.f.target')}
          value={mode}
          onChange={(v) => {
            setMode(v);
            setTargets(v === 'rooms' ? 'area_id' : 'entity_id', []);
          }}
          options={[
            { value: 'entities', label: t('vis.f.targetDevices'), icon: 'bulb' },
            { value: 'rooms', label: t('vis.f.targetRooms'), icon: 'layers' },
          ]}
        />
      )}
      {mode === 'rooms' && !isAutomation ? (
        <>
          <Chips label={t('vis.f.rooms')} multi options={rooms.map((r) => ({ value: r.id, label: r.name }))} value={areas} onChange={(v) => setTargets('area_id', v)} />
          <Hint>{t('vis.f.roomsHint')}</Hint>
        </>
      ) : (
        <EntityPicker
          label={isAutomation ? t('vis.f.automation') : t('vis.f.devices')}
          value={ids}
          onChange={(v) => setTargets('entity_id', v)}
          filter={isAutomation ? (o) => o.domain === 'automation' : (o) => CONTROLLABLE.has(o.domain) && o.domain !== 'automation'}
        />
      )}
      <SelectField
        label={t('vis.f.do')}
        value={def?.service ?? ''}
        onChange={(v) => onChange(writeName(raw, svcDomain, v))}
        options={[...(def ? [] : [{ value: '', label: name || '—' }]), ...defs.map((d) => ({ value: d.service, label: t(d.label) }))]}
      />
      {def?.fields?.map((f) => (
        <ServiceFieldInput key={f.key} field={f} value={data[f.key]} onChange={(v) => setField(f, v)} />
      ))}
    </>
  );
}

function ServiceFieldInput({ field, value, onChange }: { field: ServiceField; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const label = t(field.label);
  switch (field.type) {
    case 'percent':
    case 'kelvin':
      return <RangeInput label={label} value={value} onChange={onChange} min={field.min ?? 0} max={field.max ?? 100} step={field.step} unit={field.unit} optional={!field.required} />;
    case 'hvac':
      return (
        <SelectField
          label={label}
          value={value === undefined ? '' : String(value)}
          onChange={(v) => onChange(v || undefined)}
          options={[...(field.required ? [] : [{ value: '', label: t('vis.unchanged') }]), ...HVAC_MODES.map((m) => ({ value: m, label: t(`vis.hvac.${m}` as MessageKey) }))]}
        />
      );
    case 'text':
      return <TextInput label={label} value={value === undefined ? '' : String(value)} onChange={(v) => onChange(v || undefined)} />;
    default:
      return <NumberInput label={label} value={value} onChange={onChange} unit={field.unit} min={field.min} max={field.max} step={field.step} />;
  }
}
