/**
 * The visual automation editor's model: the raw HA-style config stays the source of truth and
 * every node is addressed by its path inside it (["actions", 1, "then", 0]). Edits are
 * immutable path operations, so fields the forms do not know about are preserved untouched.
 *
 * Pure TypeScript without DOM or React, so it runs under `node --test` (apps/web/test).
 */

export type Obj = Record<string, unknown>;
export type Path = (string | number)[];
export type Section = 'trigger' | 'condition' | 'action';

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const toList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export const pathKey = (p: Path) => p.join('/');
export const samePath = (a: Path | null | undefined, b: Path | null | undefined) => !!a && !!b && pathKey(a) === pathKey(b);
export const startsWith = (p: Path, prefix: Path) => prefix.length <= p.length && prefix.every((s, i) => p[i] === s);

// ---------------------------------------------------------------- normalizing for editing

/** Top-level spellings HA accepts → the plural lists the editor works on. */
const TOP: [string, string][] = [
  ['triggers', 'trigger'],
  ['conditions', 'condition'],
  ['actions', 'action'],
];

/**
 * Makes every list the canvas draws an actual array (HA allows scalars and singular keys) and
 * wraps bare parallel branches into `{ sequence: [...] }`. Semantics are unchanged, and the
 * result is idempotent; unknown keys and their order are kept.
 */
export function editable(config: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(config)) {
    const plural = TOP.find(([, singular]) => singular === k)?.[0];
    // `condition:` at the top level is the singular list key, never a condition kind.
    if (plural && config[plural] === undefined) out[plural] = v;
    else out[k] = v;
  }
  for (const [plural] of TOP) out[plural] = toList(out[plural]);
  out.triggers = (out.triggers as unknown[]).map(normTrigger);
  out.conditions = (out.conditions as unknown[]).map(normCondition);
  out.actions = (out.actions as unknown[]).map(normAction);
  return out;
}

function normTrigger(raw: unknown): unknown {
  return raw;
}

function normCondition(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const out: Obj = { ...raw };
  for (const key of ['and', 'or', 'not'] as const) {
    if (out[key] !== undefined && out.condition === undefined) out[key] = toList(out[key]).map(normCondition);
  }
  if (out.condition === 'and' || out.condition === 'or' || out.condition === 'not') out.conditions = toList(out.conditions).map(normCondition);
  return out;
}

function normActions(v: unknown): unknown[] {
  return toList(v).map(normAction);
}

function normAction(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const out: Obj = { ...raw };
  switch (actionKind(raw)) {
    case 'condition':
      return normCondition(out);
    case 'wait':
      out.wait_for_trigger = toList(out.wait_for_trigger).map(normTrigger);
      break;
    case 'if':
      out.if = toList(out.if).map(normCondition);
      out.then = normActions(out.then);
      if (out.else !== undefined) out.else = normActions(out.else);
      break;
    case 'choose':
      out.choose = toList(out.choose).map((o) => (isObj(o) ? { ...o, conditions: toList(o.conditions).map(normCondition), sequence: normActions(o.sequence) } : o));
      if (out.default !== undefined) out.default = normActions(out.default);
      break;
    case 'repeat': {
      if (!isObj(out.repeat)) break;
      const r: Obj = { ...out.repeat, sequence: normActions(out.repeat.sequence) };
      if (r.while !== undefined) r.while = toList(r.while).map(normCondition);
      if (r.until !== undefined) r.until = toList(r.until).map(normCondition);
      out.repeat = r;
      break;
    }
    case 'parallel':
      // Same rule as the engine: an object with `sequence` is a branch, anything else a one-step branch.
      out.parallel = toList(out.parallel).map((b) => (isObj(b) && b.sequence !== undefined ? { ...b, sequence: normActions(b.sequence) } : { sequence: [normAction(b)] }));
      break;
    case 'sequence':
      out.sequence = normActions(out.sequence);
      break;
  }
  return out;
}

// ---------------------------------------------------------------- kinds

export type TriggerKind = 'state' | 'numeric_state' | 'time' | 'time_pattern' | 'sun' | 'start' | 'webhook' | 'unknown';
export type ConditionKind = 'state' | 'numeric_state' | 'time' | 'sun' | 'and' | 'or' | 'not' | 'trigger' | 'unknown';
export type ActionKind = 'service' | 'delay' | 'wait' | 'condition' | 'if' | 'choose' | 'repeat' | 'parallel' | 'sequence' | 'stop' | 'unknown';
export type NodeKind = TriggerKind | ConditionKind | ActionKind;

export function triggerKind(raw: unknown): TriggerKind {
  if (!isObj(raw)) return 'unknown';
  const k = str(raw.trigger ?? raw.platform);
  if (k === 'homeassistant' || k === 'livynq') return 'start';
  return (['state', 'numeric_state', 'time', 'time_pattern', 'sun', 'webhook'] as const).find((x) => x === k) ?? 'unknown';
}

export function conditionKind(raw: unknown): ConditionKind {
  if (!isObj(raw)) return 'unknown';
  if (raw.condition === undefined) {
    for (const key of ['and', 'or', 'not'] as const) if (raw[key] !== undefined) return key;
    return 'unknown';
  }
  return (['state', 'numeric_state', 'time', 'sun', 'and', 'or', 'not', 'trigger'] as const).find((x) => x === raw.condition) ?? 'unknown';
}

export function actionKind(raw: unknown): ActionKind {
  if (!isObj(raw)) return 'unknown';
  if (typeof (raw.action ?? raw.service) === 'string') return 'service';
  if (raw.delay !== undefined) return 'delay';
  if (raw.wait_for_trigger !== undefined) return 'wait';
  if (raw.condition !== undefined) return 'condition';
  if (raw.choose !== undefined) return 'choose';
  if (raw.if !== undefined) return 'if';
  if (raw.repeat !== undefined) return 'repeat';
  if (raw.parallel !== undefined) return 'parallel';
  if (raw.sequence !== undefined) return 'sequence';
  if (raw.stop !== undefined) return 'stop';
  return 'unknown';
}

export function nodeKind(section: Section, raw: unknown): NodeKind {
  return section === 'trigger' ? triggerKind(raw) : section === 'condition' ? conditionKind(raw) : actionKind(raw);
}

export const isGroup = (k: NodeKind) => k === 'and' || k === 'or' || k === 'not';

// ---------------------------------------------------------------- branches (nested lists a node owns)

export type BranchRole = 'conditions' | 'if' | 'then' | 'else' | 'option' | 'default' | 'while' | 'until' | 'body' | 'lane' | 'wait' | 'sequence';

export interface Branch {
  role: BranchRole;
  section: Section;
  /** Path of the list inside the config (may not exist yet, e.g. a missing `else`). */
  path: Path;
  /** Option / lane index for choose and parallel. */
  index?: number;
  /** True when the list key is absent from the config (shown as "add else" etc.). */
  absent?: boolean;
}

/** Group conditions keep children under `conditions` or the shorthand key (`and:` / `or:` / `not:`). */
export function groupListKey(raw: Obj): string {
  if (raw.condition === undefined) for (const key of ['and', 'or', 'not']) if (raw[key] !== undefined) return key;
  return 'conditions';
}

export function branchesOf(section: Section, raw: unknown, path: Path): Branch[] {
  if (!isObj(raw)) return [];
  const kind = section === 'action' ? actionKind(raw) : section === 'condition' ? conditionKind(raw) : 'unknown';
  if (kind === 'condition') return branchesOf('condition', raw, path);
  if (isGroup(kind as NodeKind)) return [{ role: 'conditions', section: 'condition', path: [...path, groupListKey(raw)] }];
  switch (kind) {
    case 'wait':
      return [{ role: 'wait', section: 'trigger', path: [...path, 'wait_for_trigger'] }];
    case 'if':
      return [
        { role: 'if', section: 'condition', path: [...path, 'if'] },
        { role: 'then', section: 'action', path: [...path, 'then'] },
        { role: 'else', section: 'action', path: [...path, 'else'], ...(raw.else === undefined ? { absent: true } : {}) },
      ];
    case 'choose': {
      const out: Branch[] = [];
      toList(raw.choose).forEach((_, i) => {
        out.push({ role: 'option', section: 'condition', path: [...path, 'choose', i, 'conditions'], index: i });
        out.push({ role: 'option', section: 'action', path: [...path, 'choose', i, 'sequence'], index: i });
      });
      out.push({ role: 'default', section: 'action', path: [...path, 'default'], ...(raw.default === undefined ? { absent: true } : {}) });
      return out;
    }
    case 'repeat': {
      const r = isObj(raw.repeat) ? raw.repeat : {};
      const out: Branch[] = [];
      if (r.while !== undefined) out.push({ role: 'while', section: 'condition', path: [...path, 'repeat', 'while'] });
      if (r.until !== undefined) out.push({ role: 'until', section: 'condition', path: [...path, 'repeat', 'until'] });
      out.push({ role: 'body', section: 'action', path: [...path, 'repeat', 'sequence'] });
      return out;
    }
    case 'parallel':
      return toList(raw.parallel).map((_, i) => ({ role: 'lane' as const, section: 'action' as const, path: [...path, 'parallel', i, 'sequence'], index: i }));
    case 'sequence':
      return [{ role: 'sequence', section: 'action', path: [...path, 'sequence'] }];
  }
  return [];
}

// ---------------------------------------------------------------- immutable path operations

export function getAt(root: unknown, path: Path): unknown {
  let node = root;
  for (const seg of path) {
    if (typeof seg === 'number') node = Array.isArray(node) ? node[seg] : seg === 0 && node !== undefined ? node : undefined;
    else node = isObj(node) ? node[seg] : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** Sets a value; `undefined` deletes the key. Missing objects are created; scalars become lists when indexed. */
export function setAt<T>(root: T, path: Path, value: unknown): T {
  if (!path.length) return value as T;
  const [seg, ...rest] = path;
  if (typeof seg === 'number') {
    const list = [...toList(root)];
    list[seg] = setAt(list[seg], rest, value);
    return list as T;
  }
  const obj: Obj = isObj(root) ? { ...root } : {};
  const next = setAt(obj[seg!], rest, value);
  if (next === undefined) delete obj[seg!];
  else obj[seg!] = next;
  return obj as T;
}

export function updateAt<T>(root: T, path: Path, fn: (v: unknown) => unknown): T {
  return setAt(root, path, fn(getAt(root, path)));
}

export const listAt = (root: unknown, listPath: Path): unknown[] => toList(getAt(root, listPath));

export function insertAt<T>(root: T, listPath: Path, index: number, item: unknown): T {
  const list = [...listAt(root, listPath)];
  list.splice(Math.max(0, Math.min(index, list.length)), 0, item);
  return setAt(root, listPath, list);
}

const splitItem = (itemPath: Path): [Path, number] => {
  const idx = itemPath[itemPath.length - 1];
  if (typeof idx !== 'number') throw new Error(`not a list item: ${pathKey(itemPath)}`);
  return [itemPath.slice(0, -1), idx];
};

export function removeAt<T>(root: T, itemPath: Path): T {
  const [listPath, idx] = splitItem(itemPath);
  const list = [...listAt(root, listPath)];
  list.splice(idx, 1);
  return setAt(root, listPath, list);
}

export function duplicateAt<T>(root: T, itemPath: Path): T {
  const [listPath, idx] = splitItem(itemPath);
  const copy = structuredClone(getAt(root, itemPath));
  // Trigger ids identify a trigger; a copy gets its own.
  if (isObj(copy) && typeof copy.id === 'string' && (copy.trigger ?? copy.platform) !== undefined) copy.id = `${copy.id}_copy`;
  return insertAt(root, listPath, idx + 1, copy);
}

/** Moves an item within its list; `to` is the index it ends up at. */
export function moveAt<T>(root: T, listPath: Path, from: number, to: number): T {
  const list = [...listAt(root, listPath)];
  if (from < 0 || from >= list.length) return root;
  const target = Math.max(0, Math.min(to, list.length - 1));
  if (target === from) return root;
  const [item] = list.splice(from, 1);
  list.splice(target, 0, item);
  return setAt(root, listPath, list);
}

export const isEnabled = (raw: unknown) => !(isObj(raw) && raw.enabled === false);

export function toggleEnabled<T>(root: T, itemPath: Path): T {
  return updateAt(root, itemPath, (v) => {
    if (!isObj(v)) return v;
    const out = { ...v };
    if (out.enabled === false) delete out.enabled;
    else out.enabled = false;
    return out;
  });
}

/** Where a moved / inserted item lands, so selection can follow it. */
export function pathAfterMove(listPath: Path, to: number): Path {
  return [...listPath, to];
}

// ---------------------------------------------------------------- kind conversions in the inspector

/** Switches a group condition between and / or / not, keeping its children and shorthand style. */
export function setGroupKind(raw: Obj, kind: 'and' | 'or' | 'not'): Obj {
  const key = groupListKey(raw);
  const children = toList(raw[key]);
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) if (k !== key && k !== 'condition') out[k] = v;
  if (key === 'conditions') return { condition: kind, ...out, conditions: children };
  return { [kind]: children, ...out };
}

export type RepeatMode = 'count' | 'while' | 'until';

export function repeatMode(raw: Obj): RepeatMode {
  const r = isObj(raw.repeat) ? raw.repeat : {};
  return r.while !== undefined ? 'while' : r.until !== undefined ? 'until' : 'count';
}

/** Switching modes carries the condition list over between while and until. */
export function setRepeatMode(raw: Obj, mode: RepeatMode): Obj {
  const r: Obj = isObj(raw.repeat) ? { ...raw.repeat } : {};
  const conditions = toList(r.while ?? r.until);
  delete r.count;
  delete r.while;
  delete r.until;
  if (mode === 'count') r.count = 2;
  else r[mode] = conditions;
  return { ...raw, repeat: { ...r, sequence: toList(r.sequence) } };
}

// ---------------------------------------------------------------- validation errors → nodes

/** List keys whose items are nodes on the canvas. */
const NODE_LISTS = new Set(['triggers', 'conditions', 'actions', 'if', 'then', 'else', 'sequence', 'default', 'while', 'until', 'wait_for_trigger', 'and', 'or', 'not']);

/** "actions[1].then[0].target" → ["actions", 1, "then", 0, "target"]. Bare parallel branches get their `sequence`. */
export function parseErrorPath(text: string): Path {
  const out: Path = [];
  for (const m of text.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (m[2] !== undefined) {
      const n = Number(m[2]);
      // `parallel[1][0]`: an unwrapped branch is a one-item sequence in the editor.
      if (typeof out[out.length - 1] === 'number' && out[out.length - 2] === 'parallel') out.push('sequence');
      out.push(n);
    } else out.push(m[1]!);
  }
  return out;
}

/** The deepest canvas node a path points into (or null for automation-level errors). */
export function nodeOfPath(path: Path): Path | null {
  for (let i = path.length - 1; i > 0; i--) {
    if (typeof path[i] === 'number' && NODE_LISTS.has(String(path[i - 1]))) {
      // A condition used as an action is one node, not a list.
      return path.slice(0, i + 1);
    }
  }
  return null;
}

export interface NodeError {
  /** Field path below the node ("target · entity_id"), empty for the node itself. */
  field: string;
  message: string;
}

/** Server validation errors grouped by node path key; automation-level ones under "". */
export function errorsByNode(errors: string[]): Map<string, NodeError[]> {
  const out = new Map<string, NodeError[]>();
  for (const e of errors) {
    const idx = e.indexOf(': ');
    const raw = idx < 0 ? '' : e.slice(0, idx);
    const message = idx < 0 ? e : e.slice(idx + 2);
    const path = parseErrorPath(raw);
    const node = nodeOfPath(path);
    const key = node ? pathKey(node) : '';
    const field = (node ? path.slice(node.length) : path).filter((s) => typeof s === 'string').join(' · ');
    out.set(key, [...(out.get(key) ?? []), { field, message }]);
  }
  return out;
}

/**
 * Engine trace path → editor path in `config`: parallel branches gain `sequence`, a condition
 * used as an action is the action node itself (`actions/2/condition/0` → `actions/2`), and group
 * children live under the shorthand key when the config uses one (`or:` instead of `conditions:`).
 */
export function tracePath(path: string, config?: Obj): Path {
  const segs = path.split('/');
  const out: Path = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (/^\d+$/.test(seg)) {
      if (typeof out[out.length - 1] === 'number' && out[out.length - 2] === 'parallel') out.push('sequence');
      out.push(Number(seg));
      continue;
    }
    if (seg === 'condition' && segs[i + 1] === '0' && typeof out[out.length - 1] === 'number') {
      i++;
      continue;
    }
    if (seg === 'conditions' && config) {
      const node = getAt(config, out);
      if (isObj(node) && node.condition === undefined) {
        out.push(groupListKey(node));
        continue;
      }
    }
    out.push(seg);
  }
  return out;
}

export type TraceMark = 'ran' | 'failed' | 'passed' | 'blocked';

export interface TraceLike {
  trigger: { vars: Record<string, unknown> };
  conditions: { path: string; result: boolean }[];
  steps: { path: string; error?: string }[];
}

/** What a run did, per node path key: the trigger that fired, condition results and executed steps. */
export function traceMarks(config: Obj, trace: TraceLike): Map<string, TraceMark> {
  const out = new Map<string, TraceMark>();
  const idx = trace.trigger.vars.idx;
  if (idx !== undefined && /^\d+$/.test(String(idx))) out.set(pathKey(['triggers', Number(idx)]), 'ran');
  for (const c of trace.conditions) {
    const key = pathKey(tracePath(c.path, config));
    // A condition evaluated several times (repeat) shows its last result.
    out.set(key, c.result ? 'passed' : 'blocked');
  }
  for (const s of trace.steps) {
    const key = pathKey(tracePath(s.path, config));
    if (s.error) out.set(key, 'failed');
    else if (out.get(key) !== 'blocked') out.set(key, 'ran');
  }
  return out;
}

// ---------------------------------------------------------------- misc helpers for the forms

/** Trigger ids defined in the automation, for `condition: trigger`. */
export function triggerIds(config: Obj): string[] {
  return listAt(config, ['triggers'])
    .map((t) => (isObj(t) && t.id !== undefined ? String(t.id) : ''))
    .filter(Boolean);
}

/** "HH:MM:SS" from milliseconds (durations and times of day). */
export function hms(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Entity ids in a field that may be a list, a scalar or comma separated. */
export function entityList(v: unknown): string[] {
  return toList(v).flatMap((x) => str(x).split(',').map((s) => s.trim()).filter(Boolean));
}

/** One id stays a scalar, as people write it by hand. */
export const entityValue = (ids: string[]): string | string[] | undefined => (ids.length === 0 ? undefined : ids.length === 1 ? ids[0] : ids);
