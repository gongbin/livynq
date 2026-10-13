import type { ReactNode } from 'react';
import { useT, type MessageKey } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { setLang, setTheme, useResolvedTheme, usePrefs, type ThemePref } from '../lib/prefs.ts';
import { href, type Route } from '../lib/router.ts';
import { useSession } from '../lib/session.ts';
import { Icon, Logo, type IconName } from './icons.tsx';
import { Dot, IconButton, Segmented, cx } from './ui.tsx';

interface NavItem {
  route: Route;
  icon: IconName;
  label: MessageKey;
  soon?: boolean;
}

export const navItems: NavItem[] = [
  { route: 'home', icon: 'home', label: 'nav.home' },
  { route: 'devices', icon: 'list', label: 'nav.devices' },
  { route: 'rooms', icon: 'layers', label: 'nav.rooms' },
  { route: 'automations', icon: 'workflow', label: 'nav.automations', soon: true },
  { route: 'agents', icon: 'bot', label: 'nav.agents' },
  { route: 'migrate', icon: 'import', label: 'nav.migrate', soon: true },
  { route: 'ecosystems', icon: 'network', label: 'nav.ecosystems' },
];

const tabItems: NavItem[] = [
  { route: 'home', icon: 'home', label: 'nav.home' },
  { route: 'devices', icon: 'list', label: 'nav.devices' },
  { route: 'agents', icon: 'bot', label: 'nav.agents' },
  { route: 'ecosystems', icon: 'network', label: 'nav.ecosystems' },
  { route: 'more', icon: 'more', label: 'nav.more' },
];

const moreRoutes: Route[] = ['more', 'rooms', 'automations', 'migrate', 'settings'];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg text-ink">
      <Sidebar route={route} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader />
        <main id="main" className="mx-auto box-border flex w-full max-w-[1240px] flex-1 flex-col gap-4 px-4 pt-[18px] pb-7 md:gap-[22px] md:px-9 md:pt-8 md:pb-14">
          {children}
        </main>
        <TabBar route={route} />
      </div>
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useT();
  return (
    <a
      href={href(item.route)}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex items-center gap-3 rounded-ctl px-3 py-2.5 text-sm font-semibold no-underline transition-colors duration-base',
        active ? 'bg-amber-soft text-ink! hover:text-ink' : 'text-muted! hover:bg-chip hover:text-ink!',
      )}
    >
      <Icon name={item.icon} size={18} />
      <span className="flex-1">{t(item.label)}</span>
      {item.soon && <span className="rounded-full bg-chip px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-muted">{t('common.soon')}</span>}
    </a>
  );
}

function Sidebar({ route }: { route: Route }) {
  const t = useT();
  return (
    <aside className="sticky top-0 hidden h-dvh w-[236px] shrink-0 flex-col gap-6 overflow-y-auto border-r border-line bg-surface2 px-3.5 pt-[22px] pb-[18px] md:flex">
      <a href={href('home')} className="flex items-center gap-2.5 px-2 text-ink! no-underline">
        <Logo />
        <span className="text-[19px] font-extrabold tracking-[-0.02em]">Livynq</span>
      </a>
      <nav aria-label={t('nav.main')} className="flex flex-col gap-0.5">
        {navItems.map((item) => (
          <NavLink key={item.route} item={item} active={route === item.route} />
        ))}
        <a href={href('wall')} className="flex items-center gap-3 rounded-ctl px-3 py-2.5 text-sm font-semibold text-muted! no-underline transition-colors duration-base hover:bg-chip hover:text-ink!">
          <Icon name="tablet" size={18} />
          {t('nav.wall')}
        </a>
        <NavLink item={{ route: 'settings', icon: 'settings', label: 'nav.settings' }} active={route === 'settings'} />
      </nav>
      <div className="mt-auto flex flex-col gap-2.5">
        <ThemeSwitch />
        <LangSwitch />
        <StatusCard />
      </div>
    </aside>
  );
}

export function ThemeSwitch({ className }: { className?: string }) {
  const t = useT();
  const { theme } = usePrefs();
  return (
    <Segmented<ThemePref>
      label={t('theme.label')}
      size="sm"
      value={theme}
      onChange={setTheme}
      className={cx('rounded-ctl', className)}
      options={[
        { value: 'system', label: t('theme.system'), icon: 'monitor' },
        { value: 'light', label: t('theme.light'), icon: 'sun' },
        { value: 'dark', label: t('theme.dark'), icon: 'moon' },
      ]}
    />
  );
}

export function LangSwitch({ className }: { className?: string }) {
  const t = useT();
  const { lang } = usePrefs();
  return (
    <Segmented
      label={t('lang.label')}
      size="sm"
      value={lang}
      onChange={setLang}
      className={cx('rounded-ctl', className)}
      options={[
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
      ]}
    />
  );
}

function StatusCard() {
  const t = useT();
  const { status, devices } = useLive();
  const { info } = useSession();
  const tone = status === 'open' ? 'ok' : status === 'connecting' ? 'amber' : 'alert';
  const n = Object.keys(devices).length;
  return (
    <div className="rounded-[14px] border border-line p-3 text-xs leading-normal text-muted" role="status">
      <div className="flex items-center gap-1.5 font-bold text-ink">
        <Dot tone={tone} />
        {status === 'open' ? t('status.local') : status === 'connecting' ? t('status.connecting') : t('status.offline')}
      </div>
      <div>{t('status.devices', { n })}{info ? ` · ${info.adapters.join(', ')}` : ''}</div>
      <div>
        {t('status.offlineReady')}
        {info ? ` · v${info.version}` : ''}
      </div>
    </div>
  );
}

function MobileHeader() {
  const t = useT();
  const { lang, theme } = usePrefs();
  const resolved = useResolvedTheme();
  const { status } = useLive();
  // Cycle system → opposite of system → back; phones mostly want a quick flip.
  const nextTheme: ThemePref = theme === 'system' ? (resolved === 'dark' ? 'light' : 'dark') : 'system';
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-3 pt-[max(12px,env(safe-area-inset-top))] backdrop-blur-md md:hidden">
      <a href={href('home')} className="flex items-center gap-2 text-ink! no-underline">
        <Logo size={26} />
        <span className="text-[17px] font-extrabold tracking-[-0.02em]">Livynq</span>
        {status !== 'open' && (
          <span className="ml-1 flex items-center gap-1 text-[11px] font-semibold text-muted">
            <Dot tone={status === 'connecting' ? 'amber' : 'alert'} />
            {status === 'connecting' ? t('status.connecting') : t('common.offline')}
          </span>
        )}
      </a>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          aria-label={t('lang.switch')}
          className="h-10 min-w-11 rounded-ctl border-0 bg-chip px-2 text-[13px] font-bold text-ink"
        >
          {lang === 'zh' ? 'EN' : '中'}
        </button>
        <IconButton icon={resolved === 'dark' ? 'sun' : 'moon'} label={t('theme.switch')} onClick={() => setTheme(nextTheme)} className="w-11" />
      </div>
    </header>
  );
}

function TabBar({ route }: { route: Route }) {
  const t = useT();
  return (
    <nav aria-label={t('nav.main')} className="pb-safe sticky bottom-0 z-20 grid grid-cols-5 border-t border-line bg-surface/95 px-1 pt-1.5 backdrop-blur-md md:hidden">
      {tabItems.map((item) => {
        const active = item.route === 'more' ? moreRoutes.includes(route) : route === item.route;
        return (
          <a
            key={item.route}
            href={href(item.route)}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'flex min-h-[52px] flex-col items-center justify-center gap-[3px] rounded-ctl text-[10.5px] font-bold no-underline transition-colors duration-base',
              active ? 'text-amber-ink!' : 'text-muted!',
            )}
          >
            <Icon name={item.icon} size={20} />
            {t(item.label)}
          </a>
        );
      })}
    </nav>
  );
}
