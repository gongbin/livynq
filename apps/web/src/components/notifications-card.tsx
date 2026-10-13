import { useEffect, useState } from 'react';
import type { PushInfo } from '@livynq/model';
import { api, errorMessage } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { currentSubscription, disablePush, enablePush, pushSupport } from '../lib/push.ts';
import { Icon } from './icons.tsx';
import { toast } from './toast.tsx';
import { Badge, Button, Card, ErrorNote, SectionLabel, Switch } from './ui.tsx';

/** Settings → Notifications: turn Web Push on for this browser and list the token's other devices. */
export function NotificationsCard() {
  const t = useT();
  const support = pushSupport();
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [i, sub] = await Promise.all([api.pushInfo(), currentSubscription().catch(() => null)]);
      setInfo(i);
      // Subscribed in the browser but unknown to the hub (e.g. after a restore) counts as off.
      setEndpoint(sub && i.subscriptions.some((s) => s.endpoint === sub.endpoint) ? sub.endpoint : null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) {
        const sub = await enablePush();
        setEndpoint(sub.endpoint);
        toast(t('push.enabled'));
      } else {
        await disablePush();
        setEndpoint(null);
      }
      await load();
    } catch (e) {
      setError((e as Error).message === 'denied' ? t('push.denied') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      const r = await api.pushTest(endpoint ?? undefined);
      toast(r.failed ? t('push.testFailed') : t('push.testSent'), r.failed ? 'error' : 'ok');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const others = info?.subscriptions.filter((s) => s.endpoint !== endpoint) ?? [];
  const mine = info?.subscriptions.find((s) => s.endpoint === endpoint);

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <SectionLabel>{t('push.title')}</SectionLabel>
        <p className="mt-1.5 mb-0 text-[13px] leading-relaxed text-pretty text-muted">{t('push.subtitle')}</p>
      </div>
      {support === 'ok' ? (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-sm font-bold">{t('push.thisDevice')}</span>
            <span className="block text-xs text-muted">{endpoint ? t('push.on') : t('push.off')}</span>
          </span>
          <Switch checked={endpoint !== null} pending={busy} disabled={busy || !info} onChange={(v) => void toggle(v)} label={t('push.thisDevice')} />
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-[14px] bg-chip px-3.5 py-3 text-[13px] leading-relaxed text-pretty">
          <Icon name="info" size={17} className="mt-0.5 shrink-0 text-muted" />
          <span>{t(support === 'insecure' ? 'push.insecure' : support === 'iosInstall' ? 'push.iosInstall' : 'push.unsupported')}</span>
        </div>
      )}
      {mine?.lastError && <ErrorNote>{t('push.lastError', { e: mine.lastError })}</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {endpoint && (
        <div>
          <Button size="sm" icon="bell" onClick={() => void test()}>
            {t('push.test')}
          </Button>
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <span className="text-xs font-bold text-muted">{t('push.otherDevices')}</span>
          {others.map((s) => (
            <div key={s.endpoint} className="flex items-center gap-2 text-sm">
              <Icon name="bell" size={14} className="text-muted" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.lastError && <Badge tone="alert">{t('push.failing')}</Badge>}
              <Button
                size="sm"
                variant="ghost"
                icon="x"
                aria-label={t('push.remove')}
                onClick={async () => {
                  await api.pushUnsubscribe(s.endpoint).catch((e: unknown) => toast(errorMessage(e), 'error'));
                  await load();
                }}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
