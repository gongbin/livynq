import { parse, stringify, YAMLParseError } from 'yaml';
import type { DeviceDTO, Room } from '@livynq/model';
import { deviceKind, type DeviceKind } from './devices.ts';
import type { Lang } from './prefs.ts';
import type { MessageKey, Translate } from './i18n.ts';

/**
 * Browser-side helpers for Home Assistant–style automation configs:
 * YAML round-tripping, a human summary ("When … · if … → then …"), starter templates,
 * and mapping trace / validation paths back to readable labels.
 * Configs are the raw, user-written shape (not the server's normalized form), so every
 * reader here accepts HA's spellings: `trigger`/`platform`, `action`/`service`, scalar-or-list.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const toList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ---------------------------------------------------------------- YAML

const KEY_ORDER = ['id', 'alias', 'description', 'mode', 'max', 'triggers', 'trigger', 'conditions', 'condition', 'actions', 'action'];

/**
 * Config → YAML with the familiar HA key order; `omitId` for editing an existing automation.
 * Emitted as YAML 1.1 so values like "on", "off" and "07:00" are quoted: the text then means the
 * same thing to Livynq (YAML 1.2) and when pasted into Home Assistant (YAML 1.1).
 */
export function toYaml(config: Obj, omitId = false): string {
  const ordered: Obj = {};
  for (const k of KEY_ORDER) if (config[k] !== undefined && !(omitId && k === 'id')) ordered[k] = config[k];
  for (const [k, v] of Object.entries(config)) if (!(k in ordered) && !(omitId && k === 'id')) ordered[k] = v;
  return stringify(ordered, { lineWidth: 0, version: '1.1' });
}

export type YamlResult = { ok: true; value: Obj } | { ok: false; message: string; line?: number };

export function parseYaml(text: string): YamlResult {
  try {
    const value: unknown = parse(text, { prettyErrors: true });
    if (!isObj(value)) return { ok: false, message: 'YAML must describe one automation (a mapping with alias, triggers and actions)' };
    return { ok: true, value };
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const line = err.linePos?.[0]?.line;
      return { ok: false, message: (err.message.split('\n')[0] ?? err.message).replace(/:\s*$/, ''), line };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- naming context

export interface EntityRef {
  name: string;
  kind: DeviceKind;
  deviceId: string;
  roomName: string | null;
}

export interface SummaryCtx {
  t: Translate;
  lang: Lang;
  entities: Map<string, EntityRef>;
  devices: Record<string, DeviceDTO>;
  rooms: Room[];
}

const readingKey: Record<string, MessageKey> = {
  'sensor.temperature': 'dev.temperature',
  'sensor.humidity': 'dev.humidity',
  'sensor.illuminance': 'dev.illuminance',
  'sensor.battery': 'dev.battery',
  'sensor.power': 'dev.powerUse',
};

/** entity id → friendly name. Multi-entity devices get the reading appended ("Bedroom Climate · Humidity"). */
export function entityIndex(devices: Record<string, DeviceDTO>, t: Translate): Map<string, EntityRef> {
  const out = new Map<string, EntityRef>();
  for (const d of Object.values(devices)) {
    const pairs = Object.entries(d.entities);
    for (const [epId, entityId] of pairs) {
      const ep = d.endpoints.find((e) => String(e.id) === epId);
      const key = ep ? readingKey[ep.deviceType] : undefined;
      const name = pairs.length > 1 ? `${d.name} · ${key ? t(key) : entityId.split('.').pop()}` : d.name;
      out.set(entityId, { name, kind: deviceKind(d), deviceId: d.id, roomName: d.roomName });
    }
  }
  return out;
}

const entityName = (ctx: SummaryCtx, id: unknown) => {
  const s = str(id);
  if (s.startsWith('automation.')) return s.slice('automation.'.length);
  return ctx.entities.get(s)?.name ?? s;
};

function names(ctx: SummaryCtx, ids: unknown): string {
  const list = toList(ids).flatMap((x) => str(x).split(',').map((s) => s.trim()).filter(Boolean));
  if (!list.length) return '?';
  return list.map((id) => entityName(ctx, id)).join(ctx.t('sum.list'));
}

/** Human label for an entity state value ("on" on a motion sensor → "有人"). */
function stateLabel(ctx: SummaryCtx, ids: unknown, value: unknown): string {
  if (value === null) return ctx.t('sum.any');
  const v = str(value);
  const first = str(toList(ids)[0]);
  const domain = first.split('.')[0];
  const kind = ctx.entities.get(first)?.kind;
  const on = v === 'on' || v === 'true';
  const off = v === 'off' || v === 'false';
  if (!on && !off) return v;
  if (domain === 'binary_sensor') {
    if (kind === 'contact') return ctx.t(on ? 'state.open' : 'state.closed');
    if (kind === 'leak') return ctx.t(on ? 'state.leak' : 'state.dry');
    return ctx.t(on ? 'state.detected' : 'state.clear');
  }
  return ctx.t(on ? 'common.on' : 'common.off');
}

const states = (ctx: SummaryCtx, ids: unknown, v: unknown) =>
  toList(v)
    .map((x) => stateLabel(ctx, ids, x))
    .join(ctx.t('sum.orShort'));

// ---------------------------------------------------------------- durations

/** Accepts HA duration forms: seconds, "HH:MM[:SS]", or {hours, minutes, seconds, milliseconds}. */
export function durationMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  if (typeof v === 'string') {
    const s = v.trim().replace(/^-/, '');
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
    const parts = s.split(':').map(Number);
    if (parts.length >= 2 && parts.length <= 3 && parts.every((n) => Number.isFinite(n))) {
      const [h = 0, m = 0, sec = 0] = parts;
      return ((h * 60 + m) * 60 + sec) * 1000;
    }
    return undefined;
  }
  if (isObj(v)) {
    const n = (k: string) => (typeof v[k] === 'number' ? (v[k] as number) : Number(v[k] ?? 0)) || 0;
    return (((n('days') * 24 + n('hours')) * 60 + n('minutes')) * 60 + n('seconds')) * 1000 + n('milliseconds');
  }
  return undefined;
}

/** "2 分钟" / "2 min", for summaries. */
export function durationWords(ms: number, lang: Lang): string {
  const zh = lang === 'zh';
  const s = Math.round(ms / 1000);
  if (s < 60) return zh ? `${s} 秒` : `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const parts: string[] = [];
  if (h) parts.push(zh ? `${h} 小时` : `${h} h`);
  if (m) parts.push(zh ? `${m} 分钟` : `${m} min`);
  if (rest) parts.push(zh ? `${rest} 秒` : `${rest} s`);
  return parts.join(' ');
}

const dur = (ctx: SummaryCtx, v: unknown) => {
  const ms = durationMs(v);
  return ms === undefined ? str(v) : durationWords(ms, ctx.lang);
};

/** Compact span for trace timings: "184 ms", "1.4 s", "2m 07s". */
export function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

const hhmm = (v: unknown) => str(v).replace(/^(\d{1,2}:\d{2}):00$/, '$1');

// ---------------------------------------------------------------- triggers

export function describeTrigger(ctx: SummaryCtx, raw: unknown): string {
  const { t } = ctx;
  if (!isObj(raw)) return t('sum.unknown');
  const kind = str(raw.trigger ?? raw.platform);
  const forText = raw.for !== undefined ? t('sum.for', { d: dur(ctx, raw.for) }) : '';
  const subject = () => {
    const e = names(ctx, raw.entity_id);
    return raw.attribute !== undefined ? t('sum.attrOf', { e, a: str(raw.attribute) }) : e;
  };
  switch (kind) {
    case 'state': {
      const e = subject();
      if (raw.to !== undefined && raw.from !== undefined) return t('sum.state.fromTo', { e, f: states(ctx, raw.entity_id, raw.from), s: states(ctx, raw.entity_id, raw.to) }) + forText;
      if (raw.to !== undefined) return t('sum.state.to', { e, s: states(ctx, raw.entity_id, raw.to) }) + forText;
      if (raw.from !== undefined) return t('sum.state.from', { e, f: states(ctx, raw.entity_id, raw.from) }) + forText;
      return t('sum.state.change', { e }) + forText;
    }
    case 'numeric_state':
      return numeric(ctx, subject(), raw) + forText;
    case 'time': {
      const at = toList(raw.at).map(hhmm).join(ctx.t('sum.list'));
      return t('sum.time.at', { t: at || '?' });
    }
    case 'time_pattern': {
      for (const [k, unit] of [
        ['seconds', 'sum.unit.s'],
        ['minutes', 'sum.unit.m'],
        ['hours', 'sum.unit.h'],
      ] as const) {
        const v = str(raw[k]);
        if (/^\/\d+$/.test(v)) return t('sum.pattern.every', { n: v.slice(1), u: t(unit) });
      }
      const p = (['hours', 'minutes', 'seconds'] as const).map((k) => (raw[k] === undefined ? '*' : str(raw[k]))).join(':');
      return t('sum.pattern', { p });
    }
    case 'sun': {
      const base = t(raw.event === 'sunrise' ? 'sum.sunrise' : 'sum.sunset');
      return base + sunOffset(ctx, raw.offset);
    }
    case 'homeassistant':
    case 'livynq':
      return t(raw.event === 'shutdown' ? 'sum.shutdown' : 'sum.start');
    case 'webhook':
      return t('sum.webhook', { id: str(raw.webhook_id) || '?' });
    default:
      return t('sum.unknownTrigger', { k: kind || '?' });
  }
}

function sunOffset(ctx: SummaryCtx, v: unknown): string {
  if (v === undefined || v === null) return '';
  const ms = durationMs(v);
  if (!ms) return '';
  const negative = (typeof v === 'string' && v.trim().startsWith('-')) || (typeof v === 'number' && v < 0);
  return ctx.t('sum.paren', { x: ctx.t(negative ? 'sum.earlier' : 'sum.later', { d: durationWords(Math.abs(ms), ctx.lang) }) });
}

function numeric(ctx: SummaryCtx, e: string, raw: Obj): string {
  const { t } = ctx;
  if (raw.above !== undefined && raw.below !== undefined) return t('sum.between', { e, a: str(raw.above), b: str(raw.below) });
  if (raw.above !== undefined) return t('sum.above', { e, n: str(raw.above) });
  return t('sum.below', { e, n: str(raw.below) });
}

// ---------------------------------------------------------------- conditions

const WEEKDAYS: Record<Lang, Record<string, string>> = {
  zh: { mon: '周一', tue: '周二', wed: '周三', thu: '周四', fri: '周五', sat: '周六', sun: '周日' },
  en: { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' },
};

export function describeCondition(ctx: SummaryCtx, raw: unknown): string {
  const { t } = ctx;
  if (typeof raw === 'string') return raw;
  if (!isObj(raw)) return t('sum.unknown');
  for (const key of ['and', 'or', 'not'] as const) {
    if (raw[key] !== undefined && raw.condition === undefined) return group(ctx, key, raw[key]);
  }
  const subject = () => {
    const e = names(ctx, raw.entity_id);
    return raw.attribute !== undefined ? t('sum.attrOf', { e, a: str(raw.attribute) }) : e;
  };
  switch (raw.condition) {
    case 'state': {
      const text = t('sum.c.state', { e: subject(), s: states(ctx, raw.entity_id, raw.state) });
      return raw.for !== undefined ? text + t('sum.for', { d: dur(ctx, raw.for) }) : text;
    }
    case 'numeric_state':
      return numeric(ctx, subject(), raw);
    case 'time': {
      const parts: string[] = [];
      if (raw.after !== undefined && raw.before !== undefined) parts.push(t('sum.c.between', { a: hhmm(raw.after), b: hhmm(raw.before) }));
      else if (raw.after !== undefined) parts.push(t('sum.c.after', { t: hhmm(raw.after) }));
      else if (raw.before !== undefined) parts.push(t('sum.c.before', { t: hhmm(raw.before) }));
      if (raw.weekday !== undefined) parts.push(toList(raw.weekday).map((d) => WEEKDAYS[ctx.lang][str(d)] ?? str(d)).join(ctx.lang === 'zh' ? '、' : ', '));
      return parts.join(' · ') || t('sum.unknown');
    }
    case 'sun': {
      const parts: string[] = [];
      if (raw.after) parts.push(t(raw.after === 'sunrise' ? 'sum.c.afterSunrise' : 'sum.c.afterSunset') + sunOffset(ctx, raw.after_offset));
      if (raw.before) parts.push(t(raw.before === 'sunrise' ? 'sum.c.beforeSunrise' : 'sum.c.beforeSunset') + sunOffset(ctx, raw.before_offset));
      return parts.join(' · ') || t('sum.unknown');
    }
    case 'and':
    case 'or':
    case 'not':
      return group(ctx, raw.condition, raw.conditions);
    case 'trigger':
      return t('sum.c.trigger', { id: toList(raw.id).map(str).join(ctx.t('sum.orShort')) });
    default:
      return t('sum.unknownCondition', { k: str(raw.condition) || '?' });
  }
}

function group(ctx: SummaryCtx, key: 'and' | 'or' | 'not', list: unknown): string {
  const parts = toList(list).map((c) => describeCondition(ctx, c));
  if (key === 'not') return ctx.t('sum.c.not', { x: parts.join(ctx.t('sum.orWord')) });
  return parts.length > 1 ? `(${parts.join(ctx.t(key === 'and' ? 'sum.andWord' : 'sum.orWord'))})` : (parts[0] ?? '');
}

// ---------------------------------------------------------------- actions

const NAMED_AREA: Record<string, MessageKey> = { light: 'sum.area.light', switch: 'sum.area.switch' };

function targetText(ctx: SummaryCtx, domain: string, raw: Obj): string {
  const target: Obj = { ...(isObj(raw.target) ? raw.target : {}) };
  if (raw.entity_id !== undefined) target.entity_id = raw.entity_id;
  if (target.entity_id === undefined && isObj(raw.data) && raw.data.entity_id !== undefined) target.entity_id = raw.data.entity_id;
  const parts: string[] = [];
  if (target.entity_id !== undefined) parts.push(names(ctx, target.entity_id));
  for (const id of toList(target.device_id)) parts.push(ctx.devices[str(id)]?.name ?? str(id));
  for (const id of toList(target.area_id)) {
    const s = str(id).toLowerCase();
    const room = ctx.rooms.find((r) => r.id.toLowerCase() === s || r.name.toLowerCase() === s);
    parts.push(ctx.t(NAMED_AREA[domain] ?? 'sum.area.any', { a: room?.name ?? str(id) }));
  }
  return parts.join(ctx.t('sum.list')) || ctx.t('sum.nothing');
}

function serviceData(ctx: SummaryCtx, data: unknown): string {
  if (!isObj(data)) return '';
  const out: string[] = [];
  if (data.brightness_pct !== undefined) out.push(`${str(data.brightness_pct)}%`);
  else if (typeof data.brightness === 'number') out.push(`${Math.round((data.brightness / 255) * 100)}%`);
  if (data.color_temp_kelvin !== undefined) out.push(`${str(data.color_temp_kelvin)}K`);
  let text = out.length ? ` ${out.join(' · ')}` : '';
  if (data.transition !== undefined) text += ctx.t('sum.a.fade', { d: dur(ctx, data.transition) });
  return text;
}

export function describeAction(ctx: SummaryCtx, raw: unknown): string {
  const { t } = ctx;
  if (!isObj(raw)) return t('sum.unknown');
  if (typeof raw.alias === 'string' && raw.alias.trim()) return raw.alias;
  const name = raw.action ?? raw.service;
  if (typeof name === 'string') {
    const [domain = '', service = ''] = name.split('.');
    const x = targetText(ctx, domain, raw);
    if (domain === 'automation') {
      const key = service === 'turn_on' ? 'sum.a.enableAuto' : service === 'turn_off' ? 'sum.a.disableAuto' : 'sum.a.triggerAuto';
      return t(key, { x });
    }
    if (service === 'turn_on') return t('sum.a.on', { x }) + serviceData(ctx, raw.data);
    if (service === 'turn_off') return t('sum.a.off', { x }) + serviceData(ctx, raw.data);
    if (service === 'toggle') return t('sum.a.toggle', { x });
    return t('sum.a.call', { a: name, x });
  }
  if (raw.delay !== undefined) return t('sum.a.delay', { d: dur(ctx, raw.delay) });
  if (raw.wait_for_trigger !== undefined) {
    const text = t('sum.a.waitFor', { x: toList(raw.wait_for_trigger).map((tr) => describeTrigger(ctx, tr)).join(t('sum.orWord')) });
    return raw.timeout !== undefined ? text + t('sum.a.timeout', { d: dur(ctx, raw.timeout) }) : text;
  }
  if (raw.condition !== undefined) return describeCondition(ctx, raw);
  if (raw.choose !== undefined) return t('sum.a.choose', { n: toList(raw.choose).length + (raw.default ? 1 : 0) });
  if (raw.if !== undefined) {
    const c = toList(raw.if).map((x) => describeCondition(ctx, x)).join(t('sum.andWord'));
    const text = t('sum.a.if', { c, then: actionsText(ctx, raw.then) });
    return raw.else !== undefined ? text + t('sum.a.else', { x: actionsText(ctx, raw.else) }) : text;
  }
  if (isObj(raw.repeat)) {
    const r = raw.repeat;
    const x = actionsText(ctx, r.sequence);
    if (r.count !== undefined) return t('sum.a.repeat', { n: str(r.count), x });
    if (r.while !== undefined) return t('sum.a.repeatWhile', { c: toList(r.while).map((c) => describeCondition(ctx, c)).join(t('sum.andWord')), x });
    if (r.until !== undefined) return t('sum.a.repeatUntil', { c: toList(r.until).map((c) => describeCondition(ctx, c)).join(t('sum.andWord')), x });
    return t('sum.a.repeat', { n: '?', x });
  }
  if (raw.parallel !== undefined) {
    return t('sum.a.parallel', { x: toList(raw.parallel).map((b) => (isObj(b) && b.sequence !== undefined ? actionsText(ctx, b.sequence) : describeAction(ctx, b))).join(' ‖ ') });
  }
  if (raw.sequence !== undefined) return actionsText(ctx, raw.sequence);
  if (raw.stop !== undefined) return t('sum.a.stop', { x: str(raw.stop) });
  return t('sum.unknown');
}

const actionsText = (ctx: SummaryCtx, list: unknown) =>
  toList(list)
    .filter((a) => !(isObj(a) && a.enabled === false))
    .map((a) => describeAction(ctx, a))
    .join(ctx.t('sum.list'));

// ---------------------------------------------------------------- flow + one-liner

export type FlowKind = 'when' | 'if' | 'then' | 'wait';
export interface FlowLine {
  kind: FlowKind;
  text: string;
}

const active = (v: unknown) => toList(v).filter((x) => !(isObj(x) && x.enabled === false));

/** WHEN / IF / THEN / WAIT rows, as in the prototype's automation detail. */
export function automationFlow(ctx: SummaryCtx, config: Obj): FlowLine[] {
  const lines: FlowLine[] = [];
  for (const tr of active(config.triggers ?? config.trigger)) lines.push({ kind: 'when', text: describeTrigger(ctx, tr) });
  for (const c of active(config.conditions ?? config.condition)) lines.push({ kind: 'if', text: describeCondition(ctx, c) });
  for (const a of active(config.actions ?? config.action)) {
    const kind: FlowKind = isObj(a) && (a.delay !== undefined || a.wait_for_trigger !== undefined) ? 'wait' : isObj(a) && a.condition !== undefined ? 'if' : 'then';
    lines.push({ kind, text: describeAction(ctx, a) });
  }
  return lines;
}

/** "当 走廊人体 变为 有人 · 日落后 → 打开 卧室灯 30%" */
export function automationSummary(ctx: SummaryCtx, config: Obj): string {
  try {
    const flow = automationFlow(ctx, config);
    const when = flow.filter((l) => l.kind === 'when').map((l) => l.text);
    const ifs = flow.filter((l) => l.kind === 'if' && flow.indexOf(l) < flow.findIndex((x) => x.kind === 'then' || x.kind === 'wait')).map((l) => l.text);
    const rest = flow.filter((l) => l.kind !== 'when' && !ifs.includes(l.text)).map((l) => l.text);
    if (!when.length && !rest.length) return ctx.t('sum.empty');
    const head = when.length ? ctx.t('sum.when', { x: when.join(ctx.t('sum.orWord')) }) : '';
    return [head, ...ifs].filter(Boolean).join(' · ') + (rest.length ? ` → ${rest.join(ctx.t('sum.list'))}` : '');
  } catch {
    return ctx.t('sum.empty');
  }
}

// ---------------------------------------------------------------- paths (traces, validation errors)

/**
 * Resolves an engine trace path ("actions/1/then/0", "conditions/0/conditions/1") inside the raw config.
 * Best effort: the engine indexes its normalized form, which drops `enabled: false` items.
 */
export function resolvePath(config: Obj, path: string): unknown {
  const segs = path.split('/');
  let node: unknown = config;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (/^\d+$/.test(seg)) {
      node = active(node)[Number(seg)];
      continue;
    }
    if (!isObj(node)) return undefined;
    const singular: Record<string, string> = { triggers: 'trigger', conditions: 'condition', actions: 'action' };
    if (seg === 'condition' && node.condition !== undefined && !isObj(node.condition)) {
      // `- condition: state` used as an action: the action itself is the condition.
      node = [node];
      continue;
    }
    let next = node[seg] ?? (singular[seg] ? node[singular[seg]] : undefined);
    // and/or/not shorthand stores children under the operator key
    if (next === undefined && seg === 'conditions') next = node.and ?? node.or ?? node.not;
    if (seg === 'parallel') {
      const branchIdx = Number(segs[i + 1]);
      const branch = active(next)[branchIdx];
      node = isObj(branch) && branch.sequence !== undefined ? branch.sequence : [branch];
      i++;
      continue;
    }
    node = next;
  }
  return node;
}

/** "actions/1/then/0" → "动作 2 › then › 1" */
export function humanPath(t: Translate, path: string): string {
  const out: string[] = [];
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const next = segs[i + 1];
    const label: Partial<Record<string, MessageKey>> = { triggers: 'path.trigger', conditions: 'path.condition', actions: 'path.action' };
    if (label[seg] && next !== undefined && /^\d+$/.test(next) && i === 0) {
      out.push(t(label[seg]!, { n: Number(next) + 1 }));
      i++;
    } else if (/^\d+$/.test(seg)) out.push(String(Number(seg) + 1));
    else out.push(seg);
  }
  return out.join(' › ');
}

/** "triggers[0].entity_id: is required" → { where: "触发器 1 · entity_id", message: "is required" } */
export function humanError(t: Translate, error: string): { where: string; message: string } {
  const idx = error.indexOf(': ');
  if (idx < 0) return { where: '', message: error };
  const path = error.slice(0, idx);
  const message = error.slice(idx + 2);
  const where = path
    .replace(/^(triggers|conditions|actions)\[(\d+)\]/, (_, k: string, n: string) =>
      t(k === 'triggers' ? 'path.trigger' : k === 'conditions' ? 'path.condition' : 'path.action', { n: Number(n) + 1 }),
    )
    .replace(/^\./, '')
    .replace(/\./g, ' · ');
  return { where, message };
}

// ---------------------------------------------------------------- templates

export type TemplateId = 'blank' | 'motion' | 'sunset' | 'webhook';

function pick(devices: Record<string, DeviceDTO>, kinds: DeviceKind[], fallback: string): string {
  for (const kind of kinds) {
    const d = Object.values(devices).find((x) => deviceKind(x) === kind);
    const id = d && Object.values(d.entities)[0];
    if (id) return id;
  }
  return fallback;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

function randomToken(n = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Starter configs, filled in with real entity ids from this home when possible. */
export function templateConfig(id: TemplateId, ctx: { t: Translate; devices: Record<string, DeviceDTO>; taken: Set<string> }): Obj {
  const { t, devices, taken } = ctx;
  const motion = pick(devices, ['motion'], 'binary_sensor.hallway_motion');
  const light = pick(devices, ['light'], 'light.hallway');
  const plug = pick(devices, ['plug', 'switch'], 'switch.desk_plug');
  switch (id) {
    case 'motion':
      return {
        id: uniqueId('motion_night_light', taken),
        alias: t('tpl.motion.alias'),
        description: t('tpl.motion.desc'),
        mode: 'restart',
        triggers: [{ trigger: 'state', entity_id: motion, to: 'on' }],
        conditions: [{ condition: 'time', after: '20:00:00', before: '07:00:00' }],
        actions: [
          { action: 'light.turn_on', target: { entity_id: light }, data: { brightness_pct: 30 } },
          { wait_for_trigger: [{ trigger: 'state', entity_id: motion, to: 'off', for: '00:02:00' }], timeout: '00:30:00' },
          { action: 'light.turn_off', target: { entity_id: light } },
        ],
      };
    case 'sunset':
      return {
        id: uniqueId('sunset_lights_on', taken),
        alias: t('tpl.sunset.alias'),
        description: t('tpl.sunset.desc'),
        mode: 'single',
        triggers: [{ trigger: 'sun', event: 'sunset', offset: '-00:15:00' }],
        actions: [{ action: 'light.turn_on', target: { entity_id: light }, data: { brightness_pct: 80 } }],
      };
    case 'webhook':
      return {
        id: uniqueId('webhook_plug', taken),
        alias: t('tpl.webhook.alias'),
        description: t('tpl.webhook.desc'),
        mode: 'single',
        triggers: [{ trigger: 'webhook', webhook_id: `lvq_${randomToken()}`, allowed_methods: ['POST'], local_only: true }],
        actions: [{ action: 'switch.toggle', target: { entity_id: plug } }],
      };
    case 'blank':
      return {
        id: uniqueId('new_automation', taken),
        alias: t('tpl.blank.alias'),
        mode: 'single',
        triggers: [{ trigger: 'state', entity_id: motion, to: 'on' }],
        conditions: [],
        actions: [{ action: 'light.turn_on', target: { entity_id: light } }],
      };
  }
}

/** Webhook ids in a config, so the detail page can show the URL to call. */
export function webhookIds(config: Obj): string[] {
  return active(config.triggers ?? config.trigger)
    .filter((tr): tr is Obj => isObj(tr) && str(tr.trigger ?? tr.platform) === 'webhook' && typeof tr.webhook_id === 'string')
    .map((tr) => str(tr.webhook_id));
}

/** Agent- and proposal-created automations are drafts to be reviewed. */
export const isDraftSource = (createdBy: string) => /^(agent|proposal|mcp):/.test(createdBy);
