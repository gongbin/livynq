import { useEffect, useState, type ComponentType } from 'react';
import { AddDeviceHost } from './components/add-device.tsx';
import { ApprovalBanner } from './components/approvals.tsx';
import { DialogHost } from './components/dialog.tsx';
import { Shell } from './components/shell.tsx';
import { Toaster, toast } from './components/toast.tsx';
import { Button, EmptyState } from './components/ui.tsx';
import { auth } from './lib/api.ts';
import { useT } from './lib/i18n.ts';
import { connectLive, disconnectLive, onNotification } from './lib/live.ts';
import { useRoute, type Route } from './lib/router.ts';
import { clearSession, loadSession } from './lib/session.ts';
import { useStore } from './lib/store.ts';
import { AgentsPage } from './pages/agents.tsx';
import { AutomationsPage } from './pages/automations.tsx';
import { DevicesPage } from './pages/devices.tsx';
import { EcosystemsPage } from './pages/ecosystems.tsx';
import { HomePage } from './pages/home.tsx';
import { LoginPage } from './pages/login.tsx';
import { RoomsPage } from './pages/rooms.tsx';
import { MorePage, SettingsPage } from './pages/settings.tsx';
import { MigratePage } from './pages/stubs.tsx';
import { WallPage } from './pages/wall.tsx';

const pages: Record<Exclude<Route, 'wall'>, ComponentType> = {
  home: HomePage,
  devices: DevicesPage,
  rooms: RoomsPage,
  automations: AutomationsPage,
  agents: AgentsPage,
  migrate: MigratePage,
  ecosystems: EcosystemsPage,
  settings: SettingsPage,
  more: MorePage,
};

export function App() {
  const token = useStore(auth);
  return (
    <>
      {token ? <Authed key={token} /> : <LoginPage />}
      <DialogHost />
      <Toaster />
    </>
  );
}

/** Mounted per token: loads the session, owns the live connection. */
function Authed() {
  const t = useT();
  const route = useRoute();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    connectLive();
    loadSession().catch(() => setFailed(true));
    return () => {
      disconnectLive();
      clearSession();
    };
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  // Automation messages while the page is open (phones with push get them from the OS too).
  useEffect(() => onNotification((n) => toast(n.title ? `${n.title} — ${n.message}` : n.message, 'info')), []);

  if (route === 'wall')
    return (
      <>
        <WallPage />
        <ApprovalBanner />
      </>
    );
  const Page = pages[route];
  return (
    <Shell route={route}>
      <ApprovalBanner />
      {failed && (
        <EmptyState icon="wifiOff" title={t('login.unreachable')}>
          <Button
            onClick={() => {
              setFailed(false);
              loadSession().catch(() => setFailed(true));
            }}
          >
            {t('common.retry')}
          </Button>
        </EmptyState>
      )}
      <Page />
      <AddDeviceHost />
    </Shell>
  );
}
