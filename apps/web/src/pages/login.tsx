import { useState } from 'react';
import { Logo } from '../components/icons.tsx';
import { Button, ErrorNote, TextField } from '../components/ui.tsx';
import { LangSwitch, ThemeSwitch } from '../components/shell.tsx';
import { ApiError, api, signIn } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';

export function LoginPage() {
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
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-ink">
      <div className="flex w-full max-w-[400px] flex-col gap-6">
        <div className="flex items-center gap-2.5">
          <Logo size={36} />
          <span className="text-[22px] font-extrabold tracking-[-0.02em]">Livynq</span>
        </div>
        <form
          className="flex flex-col gap-5 rounded-panel border border-line bg-surface p-6 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div>
            <h1 className="m-0 text-2xl font-extrabold tracking-[-0.02em]">{t('login.title')}</h1>
            <p className="mt-1.5 mb-0 text-sm leading-relaxed text-muted">{t('login.body')}</p>
          </div>
          <TextField
            label={t('login.token')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="lvq_…"
            autoComplete="current-password"
            type="password"
            spellCheck={false}
            autoFocus
          />
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" variant="amber" busy={busy} disabled={!token.trim()} className="min-h-12">
            {t('login.submit')}
          </Button>
          <p className="m-0 text-xs leading-relaxed text-muted">{t('login.hint')}</p>
        </form>
        <div className="flex flex-col gap-2">
          <ThemeSwitch />
          <LangSwitch />
        </div>
      </div>
    </div>
  );
}
