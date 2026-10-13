import { createHash } from 'node:crypto';
import { parseDuration, parseTimeOfDay } from './duration.ts';

/**
 * Automation configs follow Home Assistant's YAML structure (triggers / conditions / actions),
 * so HA automations import mechanically and LLMs can write them from existing knowledge.
 * `normalizeAutomation` accepts HA spellings (legacy `platform:`/`service:`, singular keys,
 * scalar-or-list fields) and returns a strict internal form, or path-annotated errors.
 */

export type Mode = 'single' | 'restart' | 'queued' | 'parallel';

export type Trigger = { id?: string; enabled?: false } & (
  | { trigger: 'state'; entity_id: string[]; attribute?: string; from?: (string | null)[]; to?: (string | null)[]; not_from?: string[]; not_to?: string[]; for?: number }
  | { trigger: 'numeric_state'; entity_id: string[]; attribute?: string; above?: number; below?: number; for?: number }
  | { trigger: 'time'; at: number[] }
  | { trigger: 'time_pattern'; hours?: string; minutes?: string; seconds?: string }
  | { trigger: 'sun'; event: 'sunrise' | 'sunset'; offset: number }
  | { trigger: 'homeassistant'; event: 'start' | 'shutdown' }
  | { trigger: 'webhook'; webhook_id: string; allowed_methods: string[]; local_only: boolean }
);

export type Condition =
  | { condition: 'state'; entity_id: string[]; attribute?: string; state: (string | number | boolean)[]; for?: number; match: 'all' | 'any' }
  | { condition: 'numeric_state'; entity_id: string[]; attribute?: string; above?: number; below?: number }
  | { condition: 'time'; after?: number; before?: number; weekday?: string[] }
  | { condition: 'sun'; after?: 'sunrise' | 'sunset'; before?: 'sunrise' | 'sunset'; after_offset: number; before_offset: number }
  | { condition: 'and' | 'or' | 'not'; conditions: Condition[] }
  | { condition: 'trigger'; id: string[] };

export type Action = { alias?: string; enabled?: boolean; continue_on_error?: boolean } & (
  | { type: 'service'; action: string; target?: Record<string, string | string[]>; data?: Record<string, unknown> }
  | { type: 'delay'; delay: number }
  | { type: 'wait_for_trigger'; triggers: Trigger[]; timeout?: number; continue_on_timeout: boolean }
  | { type: 'condition'; condition: Condition }
  | { type: 'choose'; choose: { conditions: Condition[]; sequence: Action[] }[]; default?: Action[] }
  | { type: 'if'; if: Condition[]; then: Action[]; else?: Action[] }
  | { type: 'repeat'; count?: number; while?: Condition[]; until?: Condition[]; sequence: Action[] }
  | { type: 'parallel'; parallel: Action[][] }
  | { type: 'sequence'; sequence: Action[] }
  | { type: 'stop'; stop: string; error: boolean }
);

export interface Automation {
  id: string;
  alias: string;
  description?: string;
  mode: Mode;
  max: number;
  triggers: Trigger[];
  conditions: Condition[];
  actions: Action[];
}

export interface ValidationResult {
  automation?: Automation;
  errors: string[];
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

class Ctx {
  readonly errors: string[] = [];
  error(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const toList = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function strList(ctx: Ctx, path: string, v: unknown, required = true): string[] {
  const list = toList(v as string | string[]);
  if (required && !list.length) ctx.error(path, 'is required');
  return list.flatMap((x, i) => {
    if (typeof x !== 'string' || !x.trim()) {
      ctx.error(`${path}[${i}]`, 'must be a non-empty string');
      return [];
    }
    // HA allows comma separated entity ids
    return x.split(',').map((s) => s.trim()).filter(Boolean);
  });
}

function optNumber(ctx: Ctx, path: string, v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    ctx.error(path, 'must be a number (templates are not supported yet)');
    return undefined;
  }
  return n;
}

function optDuration(ctx: Ctx, path: string, v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const ms = parseDuration(v);
  if (ms === undefined) ctx.error(path, 'must be a duration like 90, "00:01:30" or {minutes: 1}');
  return ms;
}

function signedDuration(ctx: Ctx, path: string, v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'string' && v.trim().startsWith('-')) return -(optDuration(ctx, path, v.trim().slice(1)) ?? 0);
  if (typeof v === 'number' && v < 0) return -(optDuration(ctx, path, -v) ?? 0);
  return optDuration(ctx, path, v) ?? 0;
}

function list(ctx: Ctx, path: string, v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function unknownKeys(ctx: Ctx, path: string, o: Obj, allowed: string[]): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) ctx.error(`${path}.${key}`, 'unknown option');
}

// ------------------------------------------------------------------ triggers

function trigger(ctx: Ctx, path: string, raw: unknown): Trigger | undefined {
  if (!isObj(raw)) return void ctx.error(path, 'must be an object');
  const kind = raw.trigger ?? raw.platform;
  const id = raw.id === undefined ? undefined : String(raw.id);
  const base = id === undefined ? {} : { id };
  const common = ['trigger', 'platform', 'id', 'enabled', 'variables'];
  switch (kind) {
    case 'state': {
      unknownKeys(ctx, path, raw, [...common, 'entity_id', 'attribute', 'from', 'to', 'not_from', 'not_to', 'for']);
      const states = (k: string) => (raw[k] === undefined ? undefined : toList(raw[k] as string).map((s) => (s === null ? null : String(s))));
      return {
        ...base,
        trigger: 'state',
        entity_id: strList(ctx, `${path}.entity_id`, raw.entity_id),
        attribute: raw.attribute === undefined ? undefined : String(raw.attribute),
        from: states('from'),
        to: states('to'),
        not_from: states('not_from') as string[] | undefined,
        not_to: states('not_to') as string[] | undefined,
        for: optDuration(ctx, `${path}.for`, raw.for),
      };
    }
    case 'numeric_state': {
      unknownKeys(ctx, path, raw, [...common, 'entity_id', 'attribute', 'above', 'below', 'for', 'value_template']);
      if (raw.value_template !== undefined) ctx.error(`${path}.value_template`, 'templates are not supported yet');
      const t = {
        ...base,
        trigger: 'numeric_state' as const,
        entity_id: strList(ctx, `${path}.entity_id`, raw.entity_id),
        attribute: raw.attribute === undefined ? undefined : String(raw.attribute),
        above: optNumber(ctx, `${path}.above`, raw.above),
        below: optNumber(ctx, `${path}.below`, raw.below),
        for: optDuration(ctx, `${path}.for`, raw.for),
      };
      if (t.above === undefined && t.below === undefined) ctx.error(path, 'needs above and/or below');
      return t;
    }
    case 'time': {
      unknownKeys(ctx, path, raw, [...common, 'at']);
      const at = list(ctx, `${path}.at`, raw.at).map((v, i) => {
        const s = parseTimeOfDay(v);
        if (s === undefined) ctx.error(`${path}.at[${i}]`, 'must be "HH:MM" or "HH:MM:SS" (entity-based times are not supported yet)');
        return s ?? 0;
      });
      if (!at.length) ctx.error(`${path}.at`, 'is required');
      return { ...base, trigger: 'time', at };
    }
    case 'time_pattern': {
      unknownKeys(ctx, path, raw, [...common, 'hours', 'minutes', 'seconds']);
      const field = (k: 'hours' | 'minutes' | 'seconds', max: number) => {
        const v = raw[k];
        if (v === undefined) return undefined;
        const s = String(v).trim();
        const m = s.match(/^(\*|\/?\d+)$/);
        if (!m || (s !== '*' && Number(s.replace('/', '')) > max)) ctx.error(`${path}.${k}`, `must be "*", N or "/N" with N <= ${max}`);
        return s;
      };
      const t = { ...base, trigger: 'time_pattern' as const, hours: field('hours', 23), minutes: field('minutes', 59), seconds: field('seconds', 59) };
      if (!t.hours && !t.minutes && !t.seconds) ctx.error(path, 'needs hours, minutes or seconds');
      return t;
    }
    case 'sun': {
      unknownKeys(ctx, path, raw, [...common, 'event', 'offset']);
      if (raw.event !== 'sunrise' && raw.event !== 'sunset') ctx.error(`${path}.event`, 'must be sunrise or sunset');
      return { ...base, trigger: 'sun', event: raw.event === 'sunrise' ? 'sunrise' : 'sunset', offset: signedDuration(ctx, `${path}.offset`, raw.offset) };
    }
    case 'homeassistant':
    case 'livynq': {
      unknownKeys(ctx, path, raw, [...common, 'event']);
      if (raw.event !== 'start' && raw.event !== 'shutdown') ctx.error(`${path}.event`, 'must be start or shutdown');
      return { ...base, trigger: 'homeassistant', event: raw.event === 'shutdown' ? 'shutdown' : 'start' };
    }
    case 'webhook': {
      unknownKeys(ctx, path, raw, [...common, 'webhook_id', 'allowed_methods', 'local_only']);
      const webhookId = typeof raw.webhook_id === 'string' ? raw.webhook_id : '';
      if (!/^[A-Za-z0-9_-]{8,}$/.test(webhookId)) ctx.error(`${path}.webhook_id`, 'must be at least 8 characters of [A-Za-z0-9_-]');
      return {
        ...base,
        trigger: 'webhook',
        webhook_id: webhookId,
        allowed_methods: raw.allowed_methods === undefined ? ['POST', 'PUT'] : toList(raw.allowed_methods as string).map((m) => String(m).toUpperCase()),
        local_only: raw.local_only === undefined ? true : Boolean(raw.local_only),
      };
    }
    default:
      ctx.error(`${path}.trigger`, `unsupported trigger "${String(kind)}" (supported: state, numeric_state, time, time_pattern, sun, homeassistant, webhook)`);
      return undefined;
  }
}

// ------------------------------------------------------------------ conditions

function condition(ctx: Ctx, path: string, raw: unknown): Condition | undefined {
  if (typeof raw === 'string') return void ctx.error(path, 'template conditions are not supported yet');
  if (!isObj(raw)) return void ctx.error(path, 'must be an object');
  // Shorthand: { and: [...] } / { or: [...] } / { not: [...] }
  for (const key of ['and', 'or', 'not'] as const) {
    if (raw[key] !== undefined && raw.condition === undefined) {
      return { condition: key, conditions: conditionList(ctx, `${path}.${key}`, raw[key]) };
    }
  }
  const common = ['condition', 'alias', 'enabled'];
  switch (raw.condition) {
    case 'state': {
      unknownKeys(ctx, path, raw, [...common, 'entity_id', 'attribute', 'state', 'for', 'match']);
      if (raw.state === undefined) ctx.error(`${path}.state`, 'is required');
      return {
        condition: 'state',
        entity_id: strList(ctx, `${path}.entity_id`, raw.entity_id),
        attribute: raw.attribute === undefined ? undefined : String(raw.attribute),
        state: toList(raw.state as string),
        for: optDuration(ctx, `${path}.for`, raw.for),
        match: raw.match === 'any' ? 'any' : 'all',
      };
    }
    case 'numeric_state': {
      unknownKeys(ctx, path, raw, [...common, 'entity_id', 'attribute', 'above', 'below', 'value_template']);
      if (raw.value_template !== undefined) ctx.error(`${path}.value_template`, 'templates are not supported yet');
      const c = {
        condition: 'numeric_state' as const,
        entity_id: strList(ctx, `${path}.entity_id`, raw.entity_id),
        attribute: raw.attribute === undefined ? undefined : String(raw.attribute),
        above: optNumber(ctx, `${path}.above`, raw.above),
        below: optNumber(ctx, `${path}.below`, raw.below),
      };
      if (c.above === undefined && c.below === undefined) ctx.error(path, 'needs above and/or below');
      return c;
    }
    case 'time': {
      unknownKeys(ctx, path, raw, [...common, 'after', 'before', 'weekday']);
      const tod = (k: 'after' | 'before') => {
        if (raw[k] === undefined) return undefined;
        const s = parseTimeOfDay(raw[k]);
        if (s === undefined) ctx.error(`${path}.${k}`, 'must be "HH:MM[:SS]"');
        return s;
      };
      const weekday = raw.weekday === undefined ? undefined : toList(raw.weekday as string).map(String);
      weekday?.forEach((d, i) => !WEEKDAYS.includes(d) && ctx.error(`${path}.weekday[${i}]`, `must be one of ${WEEKDAYS.join(', ')}`));
      return { condition: 'time', after: tod('after'), before: tod('before'), weekday };
    }
    case 'sun': {
      unknownKeys(ctx, path, raw, [...common, 'after', 'before', 'after_offset', 'before_offset']);
      const ev = (k: 'after' | 'before') => {
        const v = raw[k];
        if (v === undefined) return undefined;
        if (v !== 'sunrise' && v !== 'sunset') ctx.error(`${path}.${k}`, 'must be sunrise or sunset');
        return v as 'sunrise' | 'sunset';
      };
      const c = { condition: 'sun' as const, after: ev('after'), before: ev('before'), after_offset: signedDuration(ctx, `${path}.after_offset`, raw.after_offset), before_offset: signedDuration(ctx, `${path}.before_offset`, raw.before_offset) };
      if (!c.after && !c.before) ctx.error(path, 'needs after and/or before');
      return c;
    }
    case 'and':
    case 'or':
    case 'not':
      unknownKeys(ctx, path, raw, [...common, 'conditions']);
      return { condition: raw.condition, conditions: conditionList(ctx, `${path}.conditions`, raw.conditions) };
    case 'trigger':
      unknownKeys(ctx, path, raw, [...common, 'id']);
      return { condition: 'trigger', id: toList(raw.id as string).map(String) };
    default:
      ctx.error(`${path}.condition`, `unsupported condition "${String(raw.condition)}" (supported: state, numeric_state, time, sun, and, or, not, trigger)`);
      return undefined;
  }
}

function conditionList(ctx: Ctx, path: string, raw: unknown): Condition[] {
  return list(ctx, path, raw)
    // Disabled items stay as no-op placeholders so trace paths match the user's YAML indexes.
    .map((c, i): Condition | undefined => (isObj(c) && c.enabled === false ? { condition: 'and', conditions: [] } : condition(ctx, `${path}[${i}]`, c)))
    .filter((c): c is Condition => Boolean(c));
}

// ------------------------------------------------------------------ actions

function action(ctx: Ctx, path: string, raw: unknown): Action | undefined {
  if (!isObj(raw)) return void ctx.error(path, 'must be an object');
  const meta = {
    ...(raw.alias === undefined ? {} : { alias: String(raw.alias) }),
    ...(raw.continue_on_error ? { continue_on_error: true } : {}),
  };
  const metaKeys = ['alias', 'enabled', 'continue_on_error'];
  const name = raw.action ?? raw.service;
  if (typeof name === 'string') {
    unknownKeys(ctx, path, raw, [...metaKeys, 'action', 'service', 'target', 'data', 'entity_id', 'metadata', 'response_variable']);
    if (!/^[a-z_]+\.[a-z_]+$/.test(name)) ctx.error(`${path}.action`, 'must look like domain.service');
    if (raw.target !== undefined && !isObj(raw.target)) ctx.error(`${path}.target`, 'must be an object');
    if (raw.data !== undefined && !isObj(raw.data)) ctx.error(`${path}.data`, 'must be an object');
    const target = { ...(raw.target as Record<string, string | string[]> | undefined) };
    if (raw.entity_id !== undefined) target.entity_id = raw.entity_id as string | string[];
    const data = raw.data as Record<string, unknown> | undefined;
    if (data && JSON.stringify(data).includes('{{')) ctx.error(`${path}.data`, 'templates are not supported yet');
    return { ...meta, type: 'service', action: name, ...(Object.keys(target).length ? { target } : {}), ...(data ? { data } : {}) };
  }
  if (raw.delay !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'delay']);
    return { ...meta, type: 'delay', delay: optDuration(ctx, `${path}.delay`, raw.delay) ?? 0 };
  }
  if (raw.wait_for_trigger !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'wait_for_trigger', 'timeout', 'continue_on_timeout']);
    const triggers = list(ctx, `${path}.wait_for_trigger`, raw.wait_for_trigger)
      .map((t, i) => trigger(ctx, `${path}.wait_for_trigger[${i}]`, t))
      .filter((t): t is Trigger => Boolean(t));
    return { ...meta, type: 'wait_for_trigger', triggers, timeout: optDuration(ctx, `${path}.timeout`, raw.timeout), continue_on_timeout: raw.continue_on_timeout !== false };
  }
  if (raw.wait_template !== undefined) return void ctx.error(`${path}.wait_template`, 'templates are not supported yet; use wait_for_trigger');
  if (raw.condition !== undefined) {
    const c = condition(ctx, path, raw);
    return c ? { ...meta, type: 'condition', condition: c } : undefined;
  }
  if (raw.choose !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'choose', 'default']);
    const choose = list(ctx, `${path}.choose`, raw.choose).map((opt, i) => {
      const p = `${path}.choose[${i}]`;
      if (!isObj(opt)) {
        ctx.error(p, 'must be an object');
        return { conditions: [], sequence: [] };
      }
      return { conditions: conditionList(ctx, `${p}.conditions`, opt.conditions), sequence: actionList(ctx, `${p}.sequence`, opt.sequence) };
    });
    return { ...meta, type: 'choose', choose, ...(raw.default === undefined ? {} : { default: actionList(ctx, `${path}.default`, raw.default) }) };
  }
  if (raw.if !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'if', 'then', 'else']);
    return {
      ...meta,
      type: 'if',
      if: conditionList(ctx, `${path}.if`, raw.if),
      then: actionList(ctx, `${path}.then`, raw.then),
      ...(raw.else === undefined ? {} : { else: actionList(ctx, `${path}.else`, raw.else) }),
    };
  }
  if (raw.repeat !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'repeat']);
    const r = isObj(raw.repeat) ? raw.repeat : {};
    const p = `${path}.repeat`;
    const count = r.count === undefined ? undefined : optNumber(ctx, `${p}.count`, r.count);
    const kinds = [r.count, r.while, r.until, r.for_each].filter((x) => x !== undefined).length;
    if (r.for_each !== undefined) ctx.error(`${p}.for_each`, 'is not supported yet');
    if (kinds !== 1) ctx.error(p, 'needs exactly one of count, while, until');
    return {
      ...meta,
      type: 'repeat',
      ...(count === undefined ? {} : { count }),
      ...(r.while === undefined ? {} : { while: conditionList(ctx, `${p}.while`, r.while) }),
      ...(r.until === undefined ? {} : { until: conditionList(ctx, `${p}.until`, r.until) }),
      sequence: actionList(ctx, `${p}.sequence`, r.sequence),
    };
  }
  if (raw.parallel !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'parallel']);
    const branches = list(ctx, `${path}.parallel`, raw.parallel).map((b, i) =>
      isObj(b) && b.sequence !== undefined ? actionList(ctx, `${path}.parallel[${i}].sequence`, b.sequence) : actionList(ctx, `${path}.parallel[${i}]`, [b]),
    );
    return { ...meta, type: 'parallel', parallel: branches };
  }
  if (raw.sequence !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'sequence']);
    return { ...meta, type: 'sequence', sequence: actionList(ctx, `${path}.sequence`, raw.sequence) };
  }
  if (raw.stop !== undefined) {
    unknownKeys(ctx, path, raw, [...metaKeys, 'stop', 'error', 'response_variable']);
    return { ...meta, type: 'stop', stop: String(raw.stop), error: Boolean(raw.error) };
  }
  for (const unsupported of ['event', 'scene', 'variables', 'device_id']) {
    if (raw[unsupported] !== undefined) return void ctx.error(path, `"${unsupported}" actions are not supported yet`);
  }
  ctx.error(path, 'unknown action (supported: action/service, delay, wait_for_trigger, condition, choose, if, repeat, parallel, sequence, stop)');
  return undefined;
}

function actionList(ctx: Ctx, path: string, raw: unknown): Action[] {
  return list(ctx, path, raw)
    .map((a, i): Action | undefined => (isObj(a) && a.enabled === false ? { type: 'sequence', sequence: [], enabled: false } : action(ctx, `${path}[${i}]`, a)))
    .filter((a): a is Action => Boolean(a));
}

// ------------------------------------------------------------------ automation

export function slugId(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export function normalizeAutomation(raw: unknown, fallbackId?: string): ValidationResult {
  const ctx = new Ctx();
  if (!isObj(raw)) return { errors: ['automation must be an object'] };
  unknownKeys(ctx, '', raw, ['id', 'alias', 'description', 'mode', 'max', 'max_exceeded', 'trigger', 'triggers', 'condition', 'conditions', 'action', 'actions', 'variables', 'trace', 'initial_state']);
  if (raw.variables !== undefined) ctx.error('variables', 'are not supported yet');

  const alias = typeof raw.alias === 'string' && raw.alias.trim() ? raw.alias.trim() : undefined;
  // Non-Latin aliases (e.g. Chinese) slugify to nothing: derive a stable id from a hash instead.
  const id = raw.id !== undefined ? String(raw.id) : (fallbackId ?? (alias ? slugId(alias) || `automation_${createHash('sha1').update(alias).digest('hex').slice(0, 10)}` : ''));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) ctx.error('id', 'must be 1-64 characters of [A-Za-z0-9_-]');
  if (!alias) ctx.error('alias', 'is required');

  const mode = (raw.mode ?? 'single') as Mode;
  if (!['single', 'restart', 'queued', 'parallel'].includes(mode)) ctx.error('mode', 'must be single, restart, queued or parallel');
  const max = raw.max === undefined ? 10 : Number(raw.max);
  if (!Number.isInteger(max) || max < 1 || max > 100) ctx.error('max', 'must be an integer 1..100');

  const triggers = list(ctx, 'triggers', raw.triggers ?? raw.trigger)
    .map((t, i): Trigger | undefined => {
      if (!(isObj(t) && t.enabled === false)) return trigger(ctx, `triggers[${i}]`, t);
      const quiet = new Ctx();
      const parsed = trigger(quiet, `triggers[${i}]`, t);
      return { ...(quiet.errors.length || !parsed ? { trigger: 'homeassistant', event: 'shutdown' } : parsed), enabled: false } as Trigger;
    })
    .filter((t): t is Trigger => Boolean(t));
  if (!triggers.length && raw.triggers === undefined && raw.trigger === undefined) ctx.error('triggers', 'at least one trigger is required');
  const conditions = conditionList(ctx, 'conditions', raw.conditions ?? raw.condition);
  const actions = actionList(ctx, 'actions', raw.actions ?? raw.action);
  if (!actions.length) ctx.error('actions', 'at least one action is required');

  if (ctx.errors.length) return { errors: ctx.errors };
  return {
    automation: { id, alias: alias!, ...(typeof raw.description === 'string' ? { description: raw.description } : {}), mode, max, triggers, conditions, actions },
    errors: [],
  };
}
