import { useEffect, useState, type ComponentType } from 'react';
import { AddDeviceHost } from './components/add-device.tsx';
import { ApprovalBanner } from './components/approvals.tsx';
import { DialogHost } from './components/dialog.tsx';
import { Shell } from './components/shell.tsx';
import { Toaster, toast } from './components/toast.tsx';
import { Button, EmptyState } from './components/ui.tsx';
import { api, auth, signIn } from './lib/api.ts';
import { useT } from './lib/i18n.ts';
import { connectLive, disconnectLive, onNotification } from './lib/live.ts';
import { useRoute, type Route } from './lib/router.ts';
import { clearSession, loadSession, useSession } from './lib/session.ts';
import { useStore } from './lib/store.ts';
import { AgentsPage } from './pages/agents.tsx';
import { AssistantPage } from './pages/assistant.tsx';
import { AutomationsPage } from './pages/automations.tsx';
import { DevicesPage } from './pages/devices.tsx';
import { EcosystemsPage } from './pages/ecosystems.tsx';
import { HomePage } from './pages/home.tsx';
import { LoginPage, OwnerSetup } from './pages/login.tsx';
import { RoomsPage } from './pages/rooms.tsx';
import { MorePage, SettingsPage } from './pages/settings.tsx';
import { PluginsPage } from './pages/plugins.tsx';
import { MigratePage } from './pages/migrate.tsx';
import { WallPage } from './pages/wall.tsx';

const pages: Record<Exclude<Route, 'wall'>, ComponentType> = {
  home: HomePage,
  devices: DevicesPage,
  rooms: RoomsPage,
  automations: AutomationsPage,
  agents: AgentsPage,
  assistant: AssistantPage,
  migrate: MigratePage,
  ecosystems: EcosystemsPage,
  plugins: PluginsPage,
  settings: SettingsPage,
  more: MorePage,
};

const SETUP_LATER = 'livynq.setupLater';
const readSession = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeSession = (k: string, v: string) => {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    // private mode
  }
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

  // Signed in with the admin link while no account exists yet: offer to create the owner.
  const { me, user } = useSession();
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    if (!me || user || me.scope !== 'admin' || readSession(SETUP_LATER)) return;
    api.authStatus().then((s) => setSetup(!s.users), () => undefined);
  }, [me, user]);
  if (setup)
    return (
      <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-ink">
        <div className="w-full max-w-[400px]">
          <OwnerSetup
            onDone={(token) => signIn(token)}
            onLater={() => {
              writeSession(SETUP_LATER, '1');
              setSetup(false);
            }}
          />
        </div>
      </div>
    );

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
