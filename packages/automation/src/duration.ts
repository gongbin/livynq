/**
 * Parses Home Assistant durations into milliseconds:
 * 90, "00:01:30", "01:30" (HH:MM), "1:30:00.5", { hours, minutes, seconds, milliseconds },
 * plus the short forms "90s", "5m", "1h", "500ms".
 */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  if (typeof value === 'string') {
    const v = value.trim();
    const short = v.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
    if (short) {
      const n = Number(short[1]);
      const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[short[2] as 'ms'];
      return Math.round(n * unit);
    }
    const hms = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
    if (hms) return Math.round((Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3] ?? 0)) * 1000);
    if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
    return undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const keys = ['days', 'hours', 'minutes', 'seconds', 'milliseconds'];
    if (Object.keys(o).some((k) => !keys.includes(k))) return undefined;
    const n = (k: string) => (o[k] === undefined ? 0 : Number(o[k]));
    const total = n('days') * 86_400_000 + n('hours') * 3_600_000 + n('minutes') * 60_000 + n('seconds') * 1000 + n('milliseconds');
    return Number.isFinite(total) && total >= 0 ? Math.round(total) : undefined;
  }
  return undefined;
}

/** "HH:MM" or "HH:MM:SS" → seconds since local midnight. */
export function parseTimeOfDay(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return undefined;
  return h * 3600 + min * 60 + s;
}

export function secondsOfDay(date: Date): number {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

/** Next local time at `seconds` after midnight, strictly after `from`. DST-safe via Date setters. */
export function nextTimeOfDay(seconds: number, from: Date): Date {
  const next = new Date(from);
  next.setHours(Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
