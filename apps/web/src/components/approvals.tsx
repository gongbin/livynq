import { useEffect, useRef, useState } from 'react';
import type { ConfirmationDTO } from '@livynq/model';
import { api, errorMessage } from '../lib/api.ts';
import { onConfirmationChange, sortConfirmations, upsertConfirmation, useConfirmations } from '../lib/confirmations.ts';
import { formatDateTime } from '../lib/format.ts';
import { useLang, useT, type Translate } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { href } from '../lib/router.ts';
import { useCan } from '../lib/session.ts';
import { useStore } from '../lib/store.ts';
import { useTick } from './appliance-controls.tsx';
import { Icon } from './icons.tsx';
import { openSheets } from './sheet.tsx';
import { toast } from './toast.tsx';
import { Badge, Button, cx } from './ui.tsx';

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "agent:claude" → "agent · claude" */
export function requesterLabel(who: string): string {
  const i = who.indexOf(':');
  return i > 0 ? `${who.slice(0, i)} · ${who.slice(i + 1)}` : who;
}

export function RiskBadge({ risk }: { risk: ConfirmationDTO['risk'] }) {
  const t = useT();
  return (
    <Badge tone={risk === 'high' ? 'alert' : risk === 'medium' ? 'amber' : 'chip'} className="px-2! py-0.5! text-[11px]!">
      <Icon name="shieldAlert" size={12} />
      {t('risk.badge', { r: t(`risk.${risk}`) })}
    </Badge>
  );
}

/** Approve / deny with busy state; the live store updates from the response (and the socket). */
export function useDecide() {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = (c: ConfirmationDTO, approve: boolean) => {
    setBusy(`${c.id}:${approve ? 'a' : 'd'}`);
    (approve ? api.approveConfirmation(c.id) : api.denyConfirmation(c.id)).then(
      (res) => {
        setBusy(null);
        upsertConfirmation(res, false);
      },
      (err: unknown) => {
        setBusy(null);
        toast(errorMessage(err), 'error');
        // It may have been decided elsewhere or expired: refresh our copy.
        void api.confirmation(c.id).then((fresh) => upsertConfirmation(fresh, false), () => undefined);
      },
    );
  };
  return { busy, decide };
}

export function DecisionButtons({ c, size = 'md' }: { c: ConfirmationDTO; size?: 'sm' | 'md' }) {
  const t = useT();
  const canAdmin = useCan('admin');
  const { busy, decide } = useDecide();
  if (!canAdmin) return <span className="text-xs font-semibold text-muted">{t('approval.adminOnly')}</span>;
  return (
    <div className="flex gap-2">
      <Button size={size} icon="x" busy={busy === `${c.id}:d`} disabled={busy !== null} onClick={() => decide(c, false)}>
        {t('approval.deny')}
      </Button>
      <Button size={size} variant="amber" icon="check" busy={busy === `${c.id}:a`} disabled={busy !== null} onClick={() => decide(c, true)}>
        {t('approval.approve')}
      </Button>
    </div>
  );
}

function decisionToast(t: Translate, c: ConfirmationDTO): void {
  if (c.status === 'pending') return;
  toast(t(`approval.done.${c.status}`, { s: c.summary }), c.status === 'executed' ? 'ok' : c.status === 'failed' ? 'error' : 'info');
}

/**
 * Global, prominent stack of pending approvals (every page, wall mode included).
 * "Later" hides one locally; it comes back on the Agents page and when the page reloads.
 */
export function ApprovalBanner() {
  const t = useT();
  const all = useConfirmations();
  const now = useTick(1000);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const sheetOpen = useStore(openSheets) > 0;

  const tRef = useRef(t);
  tRef.current = t;
  useEffect(
    () =>
      onConfirmationChange((next, prev) => {
        if (prev?.status === 'pending' && next.status !== 'pending') decisionToast(tRef.current, next);
      }),
    [],
  );

  const pending = Object.values(all)
    .filter((c) => c.status === 'pending' && c.expiresAt > now && !hidden.has(c.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!pending.length) return null;
  const shown = pending.slice(0, 2);
  const more = pending.length - shown.length;

  return (
    <div
      // On tablets/desktop a sheet is a 440px right drawer: keep the banner beside it, not on top of its header.
      className={cx('pointer-events-none fixed inset-x-0 top-0 z-[55] flex flex-col items-center gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))]', sheetOpen && 'md:right-[440px]')}
      role="region"
      aria-label={t('approval.title')}
    >
      {shown.map((c) => (
        <ApprovalCard key={c.id} c={c} now={now} onHide={() => setHidden((h) => new Set(h).add(c.id))} />
      ))}
      {more > 0 && (
        <a href={href('agents')} className="pointer-events-auto rounded-full bg-ink px-3.5 py-1.5 text-xs font-bold text-bg! no-underline shadow-sheet">
          {t('approval.more', { n: more })}
        </a>
      )}
    </div>
  );
}

function ApprovalCard({ c, now, onHide }: { c: ConfirmationDTO; now: number; onHide: () => void }) {
  const t = useT();
  const { devices } = useLive();
  const left = c.expiresAt - now;
  const device = devices[c.request.deviceId];
  return (
    <div
      role="alertdialog"
      aria-labelledby={`appr-${c.id}`}
      className="pointer-events-auto flex w-full max-w-xl animate-toast-in flex-col gap-3 rounded-panel border-2 border-alert/60 bg-surface p-4 text-ink shadow-sheet"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-tile bg-alert text-white">
          <Icon name={c.request.capability === 'doorLock' ? 'lockOpen' : 'shieldAlert'} size={21} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-extrabold tracking-[0.06em] text-alert uppercase">{t('approval.title')}</div>
          <div id={`appr-${c.id}`} className="mt-0.5 text-[15.5px] leading-snug font-extrabold break-words">
            {c.summary}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
            <span>{t('approval.requestedBy', { who: requesterLabel(c.requestedBy) })}</span>
            <RiskBadge risk={c.risk} />
            {device?.roomName && <span>· {device.roomName}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={onHide}
          aria-label={t('approval.hide')}
          title={t('approval.hide')}
          className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-lg border-0 bg-transparent text-muted hover:bg-chip hover:text-ink"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={cx('flex items-center gap-1.5 font-mono text-[13px] font-bold tabular-nums', left < 60_000 ? 'text-alert' : 'text-muted')} aria-live="off">
          <Icon name="hourglass" size={14} />
          {t('approval.expiresIn', { t: countdown(left) })}
        </span>
        <DecisionButtons c={c} />
      </div>
    </div>
  );
}

const statusTone: Record<ConfirmationDTO['status'], 'amber' | 'ok' | 'chip' | 'alert'> = {
  pending: 'amber',
  executed: 'ok',
  denied: 'chip',
  expired: 'chip',
  failed: 'alert',
};

/** Agents page list: pending first (with actions), then recent decisions with their outcome. */
export function ApprovalList() {
  const t = useT();
  const lang = useLang();
  const all = useConfirmations();
  const now = useTick(1000);
  const list = sortConfirmations(Object.values(all)).map((c) => (c.status === 'pending' && c.expiresAt <= now ? { ...c, status: 'expired' as const } : c));
  const pending = list.filter((c) => c.status === 'pending');
  const decided = list.filter((c) => c.status !== 'pending').slice(0, 20);

  return (
    <div className="flex flex-col">
      {pending.length === 0 && (
        <div className="flex items-start gap-2.5 pb-2 text-sm text-muted">
          <Icon name="circleCheck" size={18} className="mt-px shrink-0 text-ok" />
          <span className="leading-relaxed">{t('agents.approvalsEmpty')}</span>
        </div>
      )}
      {pending.map((c) => (
        <div key={c.id} className="mb-2 flex flex-col gap-3 rounded-tile border border-alert/40 bg-alert-soft/60 p-3.5">
          <div className="min-w-0">
            <div className="text-sm font-extrabold break-words">{c.summary}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
              <span>{t('approval.requestedBy', { who: requesterLabel(c.requestedBy) })}</span>
              <RiskBadge risk={c.risk} />
              <span className="font-mono tabular-nums">· {t('approval.expiresIn', { t: countdown(c.expiresAt - now) })}</span>
            </div>
          </div>
          <div className="flex justify-end">
            <DecisionButtons c={c} size="sm" />
          </div>
        </div>
      ))}
      {decided.length > 0 && (
        <>
          <div className="mt-2 mb-1 text-[11.5px] font-bold text-muted">{t('agents.approvalsHistory')}</div>
          {decided.map((c) => (
            <div key={c.id} className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line py-2.5 text-[13px] md:grid-cols-[52px_minmax(0,1fr)_auto]">
              <span className="font-mono text-xs text-muted">{formatDateTime(c.decidedAt ?? c.createdAt, lang)}</span>
              <div className="min-w-0">
                <div className="truncate font-bold">{c.summary}</div>
                <div className="truncate text-[11.5px] text-muted" title={c.error ?? undefined}>
                  {requesterLabel(c.requestedBy)}
                  {c.decidedBy ? ` · ${t('approval.decidedBy', { who: requesterLabel(c.decidedBy) })}` : ''}
                  {c.error ? ` · ${c.error}` : ''}
                </div>
              </div>
              <Badge tone={statusTone[c.status]} className="justify-self-end">
                {t(`approval.status.${c.status}`)}
              </Badge>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
