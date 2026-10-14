import { useId, useMemo, useState, type ReactNode } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { useAutomations, useSummaryCtx } from '../../lib/automation-store.ts';
import { durationMs } from '../../lib/automation.ts';
import { hms } from '../../lib/automation-flow.ts';
import { deviceKind, type DeviceKind } from '../../lib/devices.ts';
import { useT, type MessageKey } from '../../lib/i18n.ts';
import { useLive } from '../../lib/live.ts';
import { Icon, type IconName } from '../icons.tsx';
import { cx } from '../ui.tsx';

/** Form widgets for the automation inspector. All of them read the raw YAML value and write a YAML-friendly one. */

export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-bold">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs leading-snug text-pretty text-muted">{hint}</div>}
    </div>
  );
}

const inputCls =
  'min-h-11 w-full min-w-0 rounded-ctl border border-line bg-surface px-3.5 text-sm text-ink transition-colors duration-base outline-none placeholder:text-muted focus:border-amber-ink disabled:opacity-60';

export function TextInput({ label, hint, value, onChange, placeholder, mono, type = 'text' }: { label: string; hint?: ReactNode; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cx(inputCls, mono && 'font-mono text-[13px]')} spellCheck={false} autoComplete="off" />
    </Field>
  );
}

/** Number input that writes a number, or undefined when cleared. */
export function NumberInput({ label, hint, value, onChange, unit, min, max, step }: { label: string; hint?: ReactNode; value: unknown; onChange: (v: number | undefined) => void; unit?: string; min?: number; max?: number; step?: number }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined || value === null ? '' : String(value));
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={shown}
          min={min}
          max={max}
          step={step ?? 'any'}
          onChange={(e) => {
            const s = e.target.value;
            setDraft(s);
            if (s.trim() === '') onChange(undefined);
            else if (Number.isFinite(Number(s))) onChange(Number(s));
          }}
          onBlur={() => setDraft(null)}
          className={cx(inputCls, unit && 'pr-12')}
        />
        {unit && <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-[13px] font-bold text-muted">{unit}</span>}
      </div>
    </Field>
  );
}

/** Slider + number for 0–100 style values; `optional` adds an include checkbox (absent key = not sent). */
export function RangeInput({ label, value, onChange, min, max, step = 1, unit, optional }: { label: string; value: unknown; onChange: (v: number | undefined) => void; min: number; max: number; step?: number; unit?: string; optional?: boolean }) {
  const id = useId();
  const t = useT();
  const n = typeof value === 'number' ? value : Number(value);
  const on = value !== undefined && value !== null && Number.isFinite(n);
  const mid = Math.round((min + max) / 2 / step) * step;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-2 text-[13px] font-bold">
          {optional && <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? mid : undefined)} className="size-4 accent-[var(--amber)]" aria-label={t('vis.include', { x: label })} />}
          {label}
        </label>
        <span className={cx('font-mono text-[13px] font-bold tabular-nums', !on && 'text-muted')}>{on ? `${n}${unit ?? ''}` : t('vis.unchanged')}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={on ? n : mid} disabled={!on && optional} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--amber)] disabled:opacity-40" />
    </div>
  );
}

/** h / m / s inputs writing "HH:MM:SS"; empty writes undefined. */
export function DurationInput({ label, hint, value, onChange, allowEmpty = true }: { label: string; hint?: ReactNode; value: unknown; onChange: (v: string | undefined) => void; allowEmpty?: boolean }) {
  const t = useT();
  const ms = durationMs(value);
  const total = ms === undefined ? undefined : Math.round(ms / 1000);
  const parts = total === undefined ? ['', '', ''] : [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map(String);
  const set = (i: number, s: string) => {
    const next = parts.map((p, j) => (j === i ? s : p));
    if (allowEmpty && next.every((p) => p === '')) return onChange(undefined);
    const [h = 0, m = 0, sec = 0] = next.map((p) => Math.max(0, Number(p) || 0));
    onChange(hms((h * 3600 + m * 60 + sec) * 1000));
  };
  const units: MessageKey[] = ['vis.unit.h', 'vis.unit.m', 'vis.unit.s'];
  return (
    <Field label={label} hint={hint}>
      <div className={cx('grid gap-2', allowEmpty && total !== undefined ? 'grid-cols-[1fr_1fr_1fr_auto]' : 'grid-cols-3')}>
        {units.map((u, i) => (
          <div key={u} className="relative">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={i === 0 ? undefined : 59}
              value={parts[i]}
              placeholder="0"
              aria-label={`${label} · ${t(u)}`}
              onChange={(e) => set(i, e.target.value)}
              className={cx(inputCls, 'pr-9 tabular-nums')}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs font-bold text-muted">{t(u)}</span>
          </div>
        ))}
        {allowEmpty && total !== undefined && (
          <button type="button" onClick={() => onChange(undefined)} className="grid size-11 place-items-center rounded-ctl border-0 bg-chip text-muted hover:text-ink" aria-label={t('vis.clear')}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </Field>
  );
}

/** Time of day: native time input, written as "HH:MM:SS". */
export function TimeInput({ label, value, onChange, optional }: { label: string; value: unknown; onChange: (v: string | undefined) => void; optional?: boolean }) {
  const id = useId();
  const t = useT();
  const s = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  const shown = m ? `${m[1]!.padStart(2, '0')}:${m[2]}${m[3] && m[3] !== '00' ? `:${m[3]}` : ''}` : '';
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input id={id} type="time" step={1} value={shown} onChange={(e) => onChange(e.target.value ? (e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value) : undefined)} className={cx(inputCls, 'tabular-nums')} />
        {optional && shown && (
          <button type="button" onClick={() => onChange(undefined)} className="grid size-11 shrink-0 place-items-center rounded-ctl border-0 bg-chip text-muted hover:text-ink" aria-label={t('vis.clear')}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </Field>
  );
}

/** Pill choices; `multi` toggles values in a list. */
export function Chips<V extends string>({
  label,
  options,
  value,
  onChange,
  multi,
}: {
  label: string;
  options: { value: V; label: string; icon?: IconName }[];
  value: V[];
  onChange: (v: V[]) => void;
  multi?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <div className="text-[13px] font-bold">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(multi ? (on ? value.filter((v) => v !== o.value) : [...value, o.value]) : on ? [] : [o.value])}
              className={cx(
                'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-bold transition-colors duration-base',
                on ? 'border-amber bg-amber-soft text-ink' : 'border-line bg-surface text-muted hover:text-ink',
              )}
            >
              {o.icon && <Icon name={o.icon} size={14} />}
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- entities

export interface EntityOption {
  entityId: string;
  name: string;
  room: string | null;
  domain: string;
  kind: DeviceKind | 'automation';
  icon: IconName;
  unit?: string;
}

export const KIND_ICON: Record<DeviceKind | 'automation', IconName> = {
  camera: 'camera',
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
  automation: 'workflow',
};

const SENSOR: Record<string, { icon: IconName; unit: string }> = {
  'sensor.temperature': { icon: 'thermometer', unit: '°C' },
  'sensor.humidity': { icon: 'droplet', unit: '%' },
  'sensor.illuminance': { icon: 'sun', unit: 'lx' },
  'sensor.battery': { icon: 'battery', unit: '%' },
  'sensor.power': { icon: 'zap', unit: 'W' },
};

function optionsFor(d: DeviceDTO, names: Map<string, { name: string }>): EntityOption[] {
  const kind = deviceKind(d);
  return Object.entries(d.entities).map(([epId, entityId]) => {
    const ep = d.endpoints.find((e) => String(e.id) === epId);
    const domain = entityId.split('.')[0] ?? '';
    const sensor = ep ? SENSOR[ep.deviceType] : undefined;
    const own: DeviceKind = domain === 'sensor' ? 'sensor' : domain === 'binary_sensor' && ep?.deviceType === 'binarySensor.contact' ? 'contact' : domain === 'binary_sensor' && ep?.deviceType === 'binarySensor.leak' ? 'leak' : domain === 'binary_sensor' ? 'motion' : kind;
    return { entityId, name: names.get(entityId)?.name ?? d.name, room: d.roomName, domain, kind: own, icon: sensor?.icon ?? KIND_ICON[own], ...(sensor ? { unit: sensor.unit } : {}) };
  });
}

/** Every entity in the home plus `automation.*`, for pickers. */
export function useEntityOptions(): { list: EntityOption[]; byId: Map<string, EntityOption> } {
  const { devices } = useLive();
  const ctx = useSummaryCtx();
  const { list: automations } = useAutomations();
  return useMemo(() => {
    const list = Object.values(devices).flatMap((d) => optionsFor(d, ctx.entities));
    for (const a of automations ?? []) list.push({ entityId: `automation.${a.id}`, name: a.alias, room: null, domain: 'automation', kind: 'automation', icon: 'workflow' });
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { list, byId: new Map(list.map((o) => [o.entityId, o])) };
  }, [devices, ctx.entities, automations]);
}

/** Selected entities as chips, with a searchable list grouped by room to add more. */
export function EntityPicker({
  label,
  value,
  onChange,
  filter,
  multiple = true,
  hint,
}: {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
  filter?: (o: EntityOption) => boolean;
  multiple?: boolean;
  hint?: ReactNode;
}) {
  const t = useT();
  const { list, byId } = useEntityOptions();
  const [open, setOpen] = useState(value.length === 0);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = list.filter((o) => (!filter || filter(o)) && (!q || o.name.toLowerCase().includes(q) || o.entityId.includes(q) || (o.room ?? '').toLowerCase().includes(q)));
    const map = new Map<string, EntityOption[]>();
    for (const r of rows) {
      const key = r.domain === 'automation' ? t('vis.automations') : (r.room ?? t('dev.noRoom'));
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [list, filter, query, t]);

  const toggle = (id: string) => {
    if (!multiple) {
      onChange([id]);
      setOpen(false);
      return;
    }
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-2">
        {value.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {value.map((id) => {
              const o = byId.get(id);
              return (
                <li key={id} className={cx('flex items-center gap-2.5 rounded-[12px] px-2.5 py-1.5', o ? 'bg-surface2' : 'bg-alert-soft')}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-chip">
                    <Icon name={o?.icon ?? 'alert'} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold">{o?.name ?? t('vis.unknownEntity')}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">{id}</span>
                  </span>
                  <button type="button" onClick={() => onChange(value.filter((v) => v !== id))} className="grid size-8 shrink-0 place-items-center rounded-[9px] border-0 bg-transparent text-muted hover:bg-chip hover:text-ink" aria-label={t('vis.removeEntity', { x: o?.name ?? id })}>
                    <Icon name="x" size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!open ? (
          <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-10 items-center gap-2 self-start rounded-ctl border border-dashed border-line bg-transparent px-3 text-[13px] font-bold text-muted hover:border-amber hover:text-ink">
            <Icon name="plus" size={15} />
            {value.length && multiple ? t('vis.addEntity') : value.length ? t('vis.changeEntity') : t('vis.chooseEntity')}
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-2">
            <div className="relative">
              <Icon name="search" size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('auto.editor.searchEntities')}
                aria-label={t('auto.editor.searchEntities')}
                className="min-h-10 w-full rounded-[10px] border border-line bg-surface2 pr-3 pl-9 text-[13px] text-ink outline-none placeholder:text-muted focus:border-amber-ink"
                autoFocus={value.length > 0}
              />
            </div>
            <div className="flex max-h-[260px] flex-col gap-2 overflow-y-auto overscroll-contain">
              {groups.length === 0 && <div className="px-2 py-2 text-[13px] text-muted">{t('auto.editor.noEntities')}</div>}
              {groups.map(([room, rows]) => (
                <div key={room} className="flex flex-col gap-0.5">
                  <div className="px-2 pb-0.5 text-[11px] font-bold text-muted">{room}</div>
                  {rows.map((o) => {
                    const on = value.includes(o.entityId);
                    return (
                      <button
                        key={o.entityId}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(o.entityId)}
                        className={cx('flex items-center gap-2.5 rounded-[10px] border-0 px-2 py-1.5 text-left transition-colors duration-base', on ? 'bg-amber-soft' : 'bg-transparent hover:bg-chip')}
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-chip text-muted">
                          <Icon name={o.icon} size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-bold">{o.name}</span>
                          <span className="block truncate font-mono text-[11px] text-muted">{o.entityId}</span>
                        </span>
                        {on && <Icon name="check" size={15} className="shrink-0 text-amber-ink" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            {value.length > 0 && (
              <button type="button" onClick={() => setOpen(false)} className="min-h-9 rounded-[10px] border-0 bg-chip text-[13px] font-bold text-ink">
                {t('vis.done')}
              </button>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}
