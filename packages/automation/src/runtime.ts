import type { EntityState, EntityStateTracker, Logger } from '@livynq/core';
import { nextTimeOfDay, secondsOfDay } from './duration.ts';
import { nextSunEvent, sunEvent, type Location } from './sun.ts';
import type { Condition, Trigger } from './schema.ts';

export type TriggerVars = Record<string, unknown> & { platform: string; id: string; idx: string; description: string };

export interface WebhookRequest {
  method: string;
  local: boolean;
  json?: unknown;
  query: Record<string, string>;
}

export interface RuntimeEnv {
  tracker: EntityStateTracker;
  log: Logger;
  location?: Location;
  /** webhook_id -> listeners */
  webhooks: Map<string, Set<(req: WebhookRequest) => void>>;
  lifecycle: Set<(event: 'start' | 'shutdown') => void>;
}

type Fire = (vars: TriggerVars) => void;

const valueOf = (state: EntityState | undefined, attribute?: string): unknown =>
  state === undefined ? undefined : attribute ? state.attributes[attribute] : state.state;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const asString = (v: unknown) => (v === undefined || v === null ? String(v) : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Arms a trigger; returns a function that disarms it (and clears any pending `for` timers). */
export function attachTrigger(env: RuntimeEnv, trigger: Trigger, idx: number, fire: Fire): () => void {
  const id = trigger.id ?? String(idx);
  const base = { id, idx: String(idx) };
  switch (trigger.trigger) {
    case 'state': {
      const pending = new Map<string, NodeJS.Timeout>();
      const matches = (list: (string | null)[] | undefined, v: unknown) => list === undefined || list.some((x) => x === null || x === asString(v));
      const off = env.tracker.onChange(({ entityId, oldState, newState }) => {
        if (!trigger.entity_id.includes(entityId)) return;
        const from = valueOf(oldState, trigger.attribute);
        const to = valueOf(newState, trigger.attribute);
        if (same(from, to) || newState === undefined || oldState === undefined) return;
        clearTimeout(pending.get(entityId));
        pending.delete(entityId);
        // Startup / reconnect noise: ignore leaving "unknown" unless asked for explicitly.
        if (!trigger.attribute && oldState.state === 'unknown' && !trigger.from?.includes('unknown')) return;
        const ok =
          matches(trigger.from, from) &&
          matches(trigger.to, to) &&
          !(trigger.not_from ?? []).includes(asString(from)) &&
          !(trigger.not_to ?? []).includes(asString(to));
        if (!ok) return;
        const vars = (): TriggerVars => ({
          ...base,
          platform: 'state',
          entity_id: entityId,
          from_state: oldState,
          to_state: newState,
          ...(trigger.for ? { for: trigger.for } : {}),
          description: `state of ${entityId}`,
        });
        if (!trigger.for) return fire(vars());
        pending.set(entityId, setTimeout(() => (pending.delete(entityId), fire(vars())), trigger.for));
      });
      return () => {
        off();
        pending.forEach(clearTimeout);
      };
    }
    case 'numeric_state': {
      const pending = new Map<string, NodeJS.Timeout>();
      const inRange = (v: unknown) => {
        const n = typeof v === 'number' ? v : Number(v);
        if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return false;
        return (trigger.above === undefined || n > trigger.above) && (trigger.below === undefined || n < trigger.below);
      };
      const off = env.tracker.onChange(({ entityId, oldState, newState }) => {
        if (!trigger.entity_id.includes(entityId) || !newState) return;
        const before = inRange(valueOf(oldState, trigger.attribute));
        const now = inRange(valueOf(newState, trigger.attribute));
        if (!now) {
          clearTimeout(pending.get(entityId));
          pending.delete(entityId);
          return;
        }
        if (before) return; // only crossing into the range fires
        const vars = (): TriggerVars => ({ ...base, platform: 'numeric_state', entity_id: entityId, from_state: oldState, to_state: newState, above: trigger.above, below: trigger.below, description: `numeric state of ${entityId}` });
        if (!trigger.for) return fire(vars());
        pending.set(entityId, setTimeout(() => (pending.delete(entityId), fire(vars())), trigger.for));
      });
      return () => {
        off();
        pending.forEach(clearTimeout);
      };
    }
    case 'time':
      return combine(
        trigger.at.map((seconds) =>
          schedule(
            () => nextTimeOfDay(seconds, new Date()),
            (at) => fire({ ...base, platform: 'time', now: at.toISOString(), description: `time ${formatTod(seconds)}` }),
          ),
        ),
      );
    case 'time_pattern':
      return schedule(
        () => nextPatternMatch(trigger, new Date()),
        (at) => fire({ ...base, platform: 'time_pattern', now: at.toISOString(), description: 'time pattern' }),
      );
    case 'sun': {
      const location = env.location;
      if (!location) {
        env.log.warn('sun trigger ignored: set location.latitude/longitude in livynq.yaml');
        return () => {};
      }
      return schedule(
        () => nextSunEvent(trigger.event, trigger.offset, new Date(), location),
        () => fire({ ...base, platform: 'sun', event: trigger.event, offset: trigger.offset, description: trigger.event }),
      );
    }
    case 'homeassistant': {
      const listener = (event: 'start' | 'shutdown') => {
        if (event === trigger.event) fire({ ...base, platform: 'homeassistant', event, description: `Livynq ${event}` });
      };
      env.lifecycle.add(listener);
      return () => env.lifecycle.delete(listener);
    }
    case 'webhook': {
      const listener = (req: WebhookRequest) => {
        if (!trigger.allowed_methods.includes(req.method)) return;
        if (trigger.local_only && !req.local) return;
        fire({ ...base, platform: 'webhook', webhook_id: trigger.webhook_id, json: req.json, query: req.query, description: `webhook ${trigger.webhook_id}` });
      };
      let set = env.webhooks.get(trigger.webhook_id);
      if (!set) env.webhooks.set(trigger.webhook_id, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) env.webhooks.delete(trigger.webhook_id);
      };
    }
  }
}

function combine(offs: (() => void)[]): () => void {
  return () => offs.forEach((off) => off());
}

/** Re-arming one-shot timer; long delays are chunked because setTimeout caps at ~24.8 days. */
function schedule(next: () => Date | undefined, onFire: (at: Date) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const at = next();
    if (!at) return;
    const wait = () => {
      const ms = at.getTime() - Date.now();
      if (ms > 2 ** 31 - 1) timer = setTimeout(wait, 2 ** 31 - 1);
      else
        timer = setTimeout(() => {
          onFire(at);
          arm();
        }, Math.max(0, ms));
    };
    wait();
  };
  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function formatTod(seconds: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(seconds / 3600))}:${p(Math.floor((seconds % 3600) / 60))}:${p(seconds % 60)}`;
}

/** HA semantics: an unspecified smaller unit defaults to 0 when a larger one is given, larger ones to "*". */
export function nextPatternMatch(t: { hours?: string; minutes?: string; seconds?: string }, from: Date): Date {
  const hours = t.hours ?? '*';
  const minutes = t.minutes ?? (t.hours ? '0' : '*');
  const seconds = t.seconds ?? (t.hours || t.minutes ? '0' : '*');
  const match = (value: number, pattern: string) => pattern === '*' || (pattern.startsWith('/') ? value % Number(pattern.slice(1)) === 0 : value === Number(pattern));
  const d = new Date(from);
  d.setMilliseconds(0);
  d.setSeconds(d.getSeconds() + 1);
  for (let guard = 0; guard < 10_000; guard++) {
    if (!match(d.getHours(), hours)) {
      d.setHours(d.getHours() + 1, 0, 0);
      continue;
    }
    if (!match(d.getMinutes(), minutes)) {
      d.setMinutes(d.getMinutes() + 1, 0);
      continue;
    }
    if (!match(d.getSeconds(), seconds)) {
      d.setSeconds(d.getSeconds() + 1);
      continue;
    }
    return d;
  }
  throw new Error('time_pattern never matches');
}

// ------------------------------------------------------------------ conditions

export interface ConditionContext {
  env: RuntimeEnv;
  trigger?: TriggerVars;
  now?: Date;
}

/** Evaluates a condition; `record` receives every leaf result for the trace. */
export function evaluate(cond: Condition, ctx: ConditionContext, path: string, record: (path: string, result: boolean, detail?: unknown) => void): boolean {
  const now = ctx.now ?? new Date();
  let result: boolean;
  switch (cond.condition) {
    case 'state': {
      const check = (entityId: string) => {
        const state = ctx.env.tracker.get(entityId);
        const v = valueOf(state, cond.attribute);
        if (!cond.state.some((s) => asString(s) === asString(v))) return false;
        if (cond.for) {
          const since = ctx.env.tracker.lastChanged(entityId);
          return since !== undefined && now.getTime() - since >= cond.for;
        }
        return true;
      };
      result = cond.match === 'any' ? cond.entity_id.some(check) : cond.entity_id.every(check);
      break;
    }
    case 'numeric_state':
      result = cond.entity_id.every((entityId) => {
        const v = valueOf(ctx.env.tracker.get(entityId), cond.attribute);
        const n = typeof v === 'number' ? v : Number(v);
        if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return false;
        return (cond.above === undefined || n > cond.above) && (cond.below === undefined || n < cond.below);
      });
      break;
    case 'time': {
      const s = secondsOfDay(now);
      const after = cond.after ?? 0;
      const before = cond.before ?? 86_400;
      const inWindow = after <= before ? s >= after && s < before : s >= after || s < before;
      const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()]!;
      result = inWindow && (!cond.weekday || cond.weekday.includes(weekday));
      break;
    }
    case 'sun': {
      if (!ctx.env.location) {
        result = false;
        break;
      }
      const at = (ev: 'sunrise' | 'sunset', offset: number) => {
        const t = sunEvent(ev, now, ctx.env.location!);
        return t ? t.getTime() + offset : undefined;
      };
      const afterOk = cond.after ? now.getTime() > (at(cond.after, cond.after_offset) ?? Infinity) : true;
      const beforeOk = cond.before ? now.getTime() < (at(cond.before, cond.before_offset) ?? -Infinity) : true;
      // "after sunset, before sunrise" spans midnight, so it is an OR (HA behaves the same).
      result = cond.after === 'sunset' && cond.before === 'sunrise' ? afterOk || beforeOk : afterOk && beforeOk;
      break;
    }
    case 'and':
      result = cond.conditions.every((c, i) => evaluate(c, ctx, `${path}/conditions/${i}`, record));
      break;
    case 'or':
      result = cond.conditions.some((c, i) => evaluate(c, ctx, `${path}/conditions/${i}`, record));
      break;
    case 'not':
      result = !cond.conditions.some((c, i) => evaluate(c, ctx, `${path}/conditions/${i}`, record));
      break;
    case 'trigger':
      result = ctx.trigger !== undefined && cond.id.includes(ctx.trigger.id);
      break;
  }
  record(path, result);
  return result;
}
