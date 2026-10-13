import type { Lang } from './prefs.ts';

const locale = (lang: Lang) => (lang === 'zh' ? 'zh-CN' : 'en-US');

export function formatTime(ts: number, lang: Lang): string {
  return new Date(ts).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateTime(ts: number, lang: Lang): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? formatTime(ts, lang)
    : d.toLocaleString(locale(lang), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateLine(date: Date, lang: Lang): string {
  return date.toLocaleDateString(locale(lang), { weekday: 'long', month: 'long', day: 'numeric' });
}

export function formatRelative(ts: number, lang: Lang): string {
  const diff = Math.round((ts - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(diff, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function formatDuration(ms: number, lang: Lang): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (lang === 'zh') return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** HomeKit setup codes are 8 digits shown as XXX-XX-XXX. */
export function formatPincode(pin: string): string {
  const digits = pin.replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : pin;
}
