import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '../components/icons.tsx';
import { Button, ErrorNote, Spinner, TextField } from '../components/ui.tsx';
import { LangSwitch, ThemeSwitch } from '../components/shell.tsx';
import { ApiError, api, errorMessage, signIn } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-ink">
      <div className="flex w-full max-w-[400px] flex-col gap-6">
        <div className="flex items-center gap-2.5">
          <Logo size={36} />
          <span className="text-[22px] font-extrabold tracking-[-0.02em]">Livynq</span>
        </div>
        {children}
        <div className="flex flex-col gap-2">
          <ThemeSwitch />
          <LangSwitch />
        </div>
      </div>
    </div>
  );
}

const card = 'flex flex-col gap-5 rounded-panel border border-line bg-surface p-6 shadow-card';

/** Sign in with a user name and password; access tokens / login links as a fallback. */
export function LoginPage() {
  const t = useT();
  const [status, setStatus] = useState<{
    users: boolean;
    setupHere: boolean;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [useToken, setUseToken] = useState(false);

  useEffect(() => {
    api.authStatus().then(setStatus, () => setFailed(true));
  }, []);

  if (!status)
    return (
      <Frame>
        <div className={card}>{failed ? <ErrorNote>{t('login.unreachable')}</ErrorNote> : <Spinner size={20} />}</div>
      </Frame>
    );
  if (!status.users && status.setupHere)
    return (
      <Frame>
        <OwnerSetup onDone={(token) => signIn(token)} />
      </Frame>
    );
  return (
    <Frame>
      {useToken || !status.users ? (
        <>
          {!status.users && (
            <div className="rounded-[14px] bg-amber-soft px-4 py-3 text-[13px] leading-relaxed text-pretty">
              <div className="font-bold">{t('users.noAccountsTitle')}</div>
              {t('users.noAccountsBody')} <code className="font-mono">livynq login-url</code>
            </div>
          )}
          <TokenLogin />
          {status.users && (
            <button type="button" className="border-0 bg-transparent p-0 text-left text-[13px] font-bold text-muted underline" onClick={() => setUseToken(false)}>
              {t('users.backToPassword')}
            </button>
          )}
        </>
      ) : (
        <>
          <PasswordLogin />
          <button type="button" className="border-0 bg-transparent p-0 text-left text-[13px] font-bold text-muted underline" onClick={() => setUseToken(true)}>
            {t('users.useToken')}
          </button>
        </>
      )}
    </Frame>
  );
}

function PasswordLogin() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(username.trim(), password);
      signIn(r.token);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('users.wrongLogin') : err instanceof ApiError && err.status === 429 ? err.message : t('login.unreachable'));
      setBusy(false);
    }
  };
  return (
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        if (username.trim() && password) void submit();
      }}
    >
      <div>
        <h1 className="m-0 text-2xl font-extrabold tracking-[-0.02em]">{t('login.title')}</h1>
        <p className="mt-1.5 mb-0 text-sm leading-relaxed text-muted">{t('users.loginBody')}</p>
      </div>
      <TextField label={t('users.username')} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} autoFocus />
      <TextField label={t('users.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="amber" busy={busy} disabled={!username.trim() || !password} className="min-h-12">
        {t('login.submit')}
      </Button>
    </form>
  );
}

function TokenLogin() {
  const t = useT();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await api.me(value);
      signIn(value);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('login.invalid') : t('login.unreachable'));
      setBusy(false);
    }
  };
  return (
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h1 className="m-0 text-2xl font-extrabold tracking-[-0.02em]">{t('login.title')}</h1>
        <p className="mt-1.5 mb-0 text-sm leading-relaxed text-muted">{t('login.body')}</p>
      </div>
      <TextField label={t('login.token')} value={token} onChange={(e) => setToken(e.target.value)} placeholder="lvq_…" autoComplete="off" type="password" spellCheck={false} autoFocus />
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="amber" busy={busy} disabled={!token.trim()} className="min-h-12">
        {t('login.submit')}
      </Button>
      <p className="m-0 text-xs leading-relaxed text-muted">{t('login.hint')}</p>
    </form>
  );
}

/** Creates the owner account (first run). Used before sign-in on the hub machine, and after opening the login link. */
export function OwnerSetup({ onDone, onLater }: { onDone: (token: string) => void; onLater?: () => void }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = repeat.length > 0 && repeat !== password;
  const ready = username.trim().length >= 2 && password.length >= 8 && password === repeat;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.setupOwner({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        password,
      });
      onDone(r.token);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void submit();
      }}
    >
      <div>
        <h1 className="m-0 text-2xl font-extrabold tracking-[-0.02em]">{t('users.setupTitle')}</h1>
        <p className="mt-1.5 mb-0 text-sm leading-relaxed text-pretty text-muted">{t('users.setupBody')}</p>
      </div>
      <TextField
        label={t('users.username')}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
        hint={t('users.usernameHint')}
      />
      <TextField label={t('users.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username || t('users.displayNamePh')} />
      <TextField label={t('users.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" hint={t('users.passwordHint')} />
      <TextField label={t('users.repeat')} type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" hint={mismatch ? t('users.mismatch') : undefined} />
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="amber" busy={busy} disabled={!ready} className="min-h-12">
        {t('users.createOwner')}
      </Button>
      {onLater && (
        <button type="button" className="border-0 bg-transparent p-0 text-left text-[13px] font-bold text-muted underline" onClick={onLater}>
          {t('users.later')}
        </button>
      )}
    </form>
  );
}
