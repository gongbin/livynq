/**
 * A deliberately small subset of Home Assistant's Jinja2 templates, enough for MQTT discovery:
 *   {{ value }}  {{ value_json.a.b }}  {{ value_json['a'] }}  {{ value_json.a | float | round(1) }}
 *   filters: float, int, round(n), default(x), lower, upper, string, bool
 * Anything else (statements, expressions) throws UnsupportedTemplateError.
 */
export class UnsupportedTemplateError extends Error {}

export type TemplateValue = string | number | boolean | null | undefined | object;

export interface CompiledTemplate {
  render(value: string, variables?: Record<string, unknown>): TemplateValue;
}

const EXPR = /^\{\{\s*(.+?)\s*\}\}$/s;

export function compileTemplate(source: string | undefined): CompiledTemplate {
  if (!source) return { render: (value) => value };
  const match = source.trim().match(EXPR);
  if (!match || source.includes('{%')) throw new UnsupportedTemplateError(`Unsupported template: ${source}`);
  const [head, ...filters] = splitPipes(match[1]!);
  const path = parsePath(head!.trim());
  const steps = filters.map((f) => parseFilter(f.trim()));
  return {
    render(value, variables = {}) {
      let root: Record<string, unknown> = { value, ...variables };
      if (path[0] === 'value_json') {
        try {
          root = { ...root, value_json: JSON.parse(value) };
        } catch {
          root = { ...root, value_json: undefined };
        }
      }
      let current: unknown = root;
      for (const key of path) current = current === null || current === undefined ? undefined : (current as Record<string, unknown>)[key];
      for (const step of steps) current = step(current);
      return current as TemplateValue;
    },
  };
}

function splitPipes(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '|' && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function parsePath(expr: string): string[] {
  if (!/^(value|value_json)((\.[A-Za-z_][\w-]*)|(\[\s*('[^']*'|"[^"]*"|\d+)\s*\]))*$/.test(expr)) {
    throw new UnsupportedTemplateError(`Unsupported template expression: ${expr}`);
  }
  const keys: string[] = [];
  const re = /\.([A-Za-z_][\w-]*)|\[\s*(?:'([^']*)'|"([^"]*)"|(\d+))\s*\]/g;
  keys.push(expr.match(/^\w+/)![0]);
  for (const m of expr.matchAll(re)) keys.push(m[1] ?? m[2] ?? m[3] ?? m[4]!);
  return keys;
}

function parseFilter(filter: string): (v: unknown) => unknown {
  const m = filter.match(/^(\w+)(?:\((.*)\))?$/s);
  if (!m) throw new UnsupportedTemplateError(`Unsupported filter: ${filter}`);
  const [, name, rawArg] = m;
  const arg = rawArg === undefined || rawArg.trim() === '' ? undefined : parseLiteral(rawArg.trim());
  switch (name) {
    case 'float':
      return (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : (arg ?? 0));
    case 'int':
      return (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.trunc(Number(v)) : (arg ?? 0));
    case 'round':
      return (v) => {
        const digits = typeof arg === 'number' ? arg : 0;
        const f = 10 ** digits;
        return Math.round(Number(v) * f) / f;
      };
    case 'default':
      return (v) => (v === undefined ? arg : v);
    case 'lower':
      return (v) => String(v).toLowerCase();
    case 'upper':
      return (v) => String(v).toUpperCase();
    case 'string':
      return (v) => String(v);
    case 'bool':
      return (v) => ['true', 'on', 'yes', '1'].includes(String(v).toLowerCase());
    default:
      throw new UnsupportedTemplateError(`Unsupported filter: ${name}`);
  }
}

function parseLiteral(raw: string): unknown {
  if (/^(['"]).*\1$/s.test(raw)) return raw.slice(1, -1);
  if (raw === 'true' || raw === 'True') return true;
  if (raw === 'false' || raw === 'False') return false;
  if (raw === 'none' || raw === 'None') return null;
  if (Number.isFinite(Number(raw))) return Number(raw);
  throw new UnsupportedTemplateError(`Unsupported filter argument: ${raw}`);
}

/** Loose equality used to compare rendered values with payload_on/state_on (HA renders Python bools as True/False). */
export function payloadEquals(rendered: TemplateValue, expected: unknown): boolean {
  if (rendered === undefined || expected === undefined) return false;
  const norm = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).toLowerCase();
  return norm(rendered) === norm(expected);
}
