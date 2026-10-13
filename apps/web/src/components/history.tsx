import { useEffect, useState } from 'react';
import type { DeviceDTO } from '@livynq/model';
import { api, type HistoryPoint } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { readings, round1, type Reading } from '../lib/devices.ts';
import { SectionLabel, Segmented, Spinner } from './ui.tsx';

const HOURS = 24;
const HOUR = 3600_000;

/**
 * 24 hourly bars (the prototype's "last 24 hours" strip) for a numeric attribute.
 * History only stores changes, so each hour carries the last known value forward.
 */
function bucketize(points: HistoryPoint[], now: number): (number | null)[] {
  const start = now - HOURS * HOUR;
  const sorted = points.filter((p) => typeof p.value === 'number').sort((a, b) => a.ts - b.ts) as { ts: number; value: number }[];
  const out: (number | null)[] = [];
  let i = 0;
  let last: number | null = null;
  for (let h = 0; h < HOURS; h++) {
    const end = start + (h + 1) * HOUR;
    let sum = 0;
    let n = 0;
    while (i < sorted.length && sorted[i]!.ts < end) {
      sum += sorted[i]!.value;
      n++;
      last = sorted[i]!.value;
      i++;
    }
    out.push(n ? sum / n : last);
  }
  return out;
}

export function HistoryStrip({ device }: { device: DeviceDTO }) {
  const t = useT();
  const rs = readings(device);
  const [selected, setSelected] = useState(0);
  const r: Reading | undefined = rs[Math.min(selected, rs.length - 1)];
  const [data, setData] = useState<HistoryPoint[] | null>(null);
  const [error, setError] = useState(false);
  const key = r ? `${r.endpointId}/${r.capability}/${r.attribute}` : '';

  useEffect(() => {
    if (!r) return;
    let cancelled = false;
    setData(null);
    setError(false);
    api
      .history(device.id, { endpoint: r.endpointId, capability: r.capability, attribute: r.attribute, from: Date.now() - HOURS * HOUR })
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
    // Refetch only when the series changes, not on every live value update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id, key]);

  if (!r) return null;
  const now = Date.now();
  // The current value always counts for the latest hour, even if nothing changed recently.
  const buckets = data ? bucketize([...data, { ts: now - 1, value: r.value }], now) : [];
  const values = buckets.filter((v): v is number => v !== null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const span = max - min || Math.abs(max) || 1;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>{t('dev.last24h')}</SectionLabel>
        {values.length > 0 && (
          <span className="font-mono text-xs text-muted">
            {t('dev.min')} {round1(min)} · {t('dev.max')} {round1(max)}
          </span>
        )}
      </div>
      {rs.length > 1 && (
        <Segmented
          size="sm"
          label={t('dev.last24h')}
          value={String(Math.min(selected, rs.length - 1))}
          onChange={(v) => setSelected(Number(v))}
          options={rs.map((x, i) => ({ value: String(i), label: t(x.label), icon: x.icon }))}
        />
      )}
      <div className="relative h-14">
        {data === null && !error ? (
          <div className="grid h-full place-items-center text-muted">
            <Spinner />
          </div>
        ) : error || !values.length ? (
          <div className="grid h-full place-items-center text-[13px] text-muted">{t('dev.noHistory')}</div>
        ) : (
          <svg viewBox={`0 0 ${HOURS * 10} 56`} preserveAspectRatio="none" className="h-full w-full" role="img" aria-label={`${t(r.label)}: ${t('dev.min')} ${round1(min)}, ${t('dev.max')} ${round1(max)}`}>
            {buckets.map((v, i) => {
              const h = v === null ? 4 : 8 + ((v - min) / span) * 48;
              const high = v !== null && (v - min) / span > 0.6;
              return <rect key={i} x={i * 10 + 1.5} y={56 - h} width={7} height={h} rx={2.5} fill={v === null ? 'var(--chip)' : high ? 'var(--amber)' : 'color-mix(in oklch, var(--amber) 30%, var(--chip))'} opacity={v === null ? 0.5 : 1} />;
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
