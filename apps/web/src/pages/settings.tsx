import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icons.tsx';
import { LangSwitch, ThemeSwitch } from '../components/shell.tsx';
import { Badge, Button, Card, PageHeader, SectionLabel } from '../components/ui.tsx';
import { signOut } from '../lib/api.ts';
import { formatDuration } from '../lib/format.ts';
import { useLang, useT, type MessageKey } from '../lib/i18n.ts';
import { href, type Route } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { useNow } from './home.tsx';

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line py-3 text-sm first:border-t-0">
      <span className="text-muted">{k}</span>
      <span className="min-w-0 text-right font-semibold break-words">{children}</span>
    </div>
  );
}

export function SettingsPage() {
  const t = useT();
  const lang = useLang();
  const { info, me } = useSession();
  const now = useNow(60_000);
  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <SectionLabel>{t('settings.appearance')}</SectionLabel>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-bold">{t('theme.label')}</span>
            <ThemeSwitch />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-bold">{t('lang.label')}</span>
            <LangSwitch />
          </div>
        </Card>
        <Card className="flex flex-col gap-1">
          <SectionLabel className="mb-2">{t('settings.about')}</SectionLabel>
          <Row k={t('settings.version')}>{info ? `Livynq v${info.version}` : '—'}</Row>
          <Row k={t('settings.uptime')}>{info ? formatDuration(now.getTime() - info.startedAt, lang) : '—'}</Row>
          <Row k={t('settings.devices')}>{info?.deviceCount ?? '—'}</Row>
          <Row k={t('settings.adapters')}>
            <span className="flex flex-wrap justify-end gap-1">{info?.adapters.map((a) => <Badge key={a}>{a}</Badge>) ?? '—'}</span>
          </Row>
          <Row k={t('settings.homekit')}>{info ? (info.homekit.enabled ? t('settings.enabled') : t('settings.disabled')) : '—'}</Row>
          <Row k={t('settings.mcpPath')}>
            <code className="font-mono text-xs">{info ? `${location.origin}${info.mcp.path}` : '—'}</code>
          </Row>
        </Card>
        <Card className="flex flex-col gap-3">
          <SectionLabel>{t('settings.session')}</SectionLabel>
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-[11px] bg-chip">
              <Icon name="key" size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted">{t('settings.signedInAs')}</div>
              <div className="truncate text-sm font-bold">
                {me?.name ?? '—'} {me && <Badge className="ml-1">{t(`agents.scope.${me.scope}`)}</Badge>}
              </div>
            </div>
            <Button icon="logOut" onClick={signOut}>
              {t('settings.signOut')}
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}

const moreItems: { route: Route; icon: IconName; label: MessageKey; soon?: boolean }[] = [
  { route: 'rooms', icon: 'layers', label: 'nav.rooms' },
  { route: 'automations', icon: 'workflow', label: 'nav.automations', soon: true },
  { route: 'migrate', icon: 'import', label: 'nav.migrate', soon: true },
  { route: 'wall', icon: 'tablet', label: 'nav.wall' },
  { route: 'settings', icon: 'settings', label: 'nav.settings' },
];

/** Mobile overflow menu for destinations that do not fit the 5-slot tab bar. */
export function MorePage() {
  const t = useT();
  return (
    <>
      <PageHeader title={t('more.title')} />
      <Card className="flex flex-col p-1.5!">
        {moreItems.map((m) => (
          <a key={m.route} href={href(m.route)} className="flex items-center gap-3 rounded-[15px] p-3 text-ink! no-underline transition-colors duration-base hover:bg-surface2">
            <span className="grid size-9 place-items-center rounded-[11px] bg-chip text-muted">
              <Icon name={m.icon} size={17} />
            </span>
            <span className="flex-1 text-[14.5px] font-bold">{t(m.label)}</span>
            {m.soon && <Badge tone="amber">{t('common.soon')}</Badge>}
            <Icon name="chevronRight" size={16} className="text-muted" />
          </a>
        ))}
      </Card>
    </>
  );
}
