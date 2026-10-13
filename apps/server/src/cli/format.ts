import { summarizeDevice } from '@livynq/agent';
import type { DeviceDTO } from '@livynq/model';

export function table(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return '(none)';
  const cols = columns ?? Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const width = (c: string) => Math.min(48, Math.max(displayWidth(c), ...rows.map((r) => displayWidth(cell(r[c])))));
  const widths = cols.map(width);
  const line = (vals: string[]) => vals.map((v, i) => pad(truncate(v, widths[i]!), widths[i]!)).join('  ').trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

/** CJK characters take two terminal columns. */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
}

function truncate(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  let out = '';
  for (const ch of s) {
    if (displayWidth(out + ch) > w - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function deviceRows(devices: DeviceDTO[]) {
  return devices.map((d) => {
    const s = summarizeDevice(d);
    const state = s.endpoints.map((e) => Object.entries(e.state).map(([k, v]) => `${k}=${v}`).join(' ')).filter(Boolean).join(' | ');
    return { entity: Object.values(d.entities)[0] ?? '', name: d.name, room: d.roomName ?? '', status: d.availability, state };
  });
}
