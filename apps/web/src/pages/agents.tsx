import { useCallback, useEffect, useState } from 'react';
import type { Risk, TokenScope } from '@livynq/model';
import { ApprovalList } from '../components/approvals.tsx';
import { Icon } from '../components/icons.tsx';
import { toast } from '../components/toast.tsx';
import { Badge, Button, Card, ConfirmButton, CopyButton, Dot, ErrorNote, PageHeader, SectionLabel, Segmented, Spinner, TextField, cx } from '../components/ui.tsx';
import { ApiError, api, errorMessage, type AuditRow, type TokenInfo } from '../lib/api.ts';
import { loadPendingConfirmations, loadRecentConfirmations, useConfirmations } from '../lib/confirmations.ts';
import { formatDateTime, formatRelative } from '../lib/format.ts';
import { useLang, useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { useCan, useSession } from '../lib/session.ts';

export function AgentsPage() {
  const t = useT();
  const { info } = useSession();
  const [fresh, setFresh] = useState<string | null>(null);
  const mcpUrl = `${location.origin}${info?.mcp.path ?? '/mcp'}`;
  return (
    <>
      <PageHeader
        title={t('agents.title')}
        subtitle={t('agents.subtitle')}
        actions={
          <span className="flex items-center gap-2 rounded-full bg-ok-soft px-3.5 py-2 text-[13px] font-bold">
            <Dot tone="ok" />
            MCP · {location.host}
            {info?.mcp.path ?? '/mcp'}
          </span>
        }
      />
      <p className="-mt-1 mb-0 max-w-3xl text-sm leading-relaxed text-pretty">{t('agents.mcp')}</p>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ApprovalsCard />
          <AuditCard />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <TokensCard onCreated={setFresh} />
          <ConnectCard url={mcpUrl} token={fresh} />
        </div>
      </div>
    </>
  );
}

function ApprovalsCard() {
  const t = useT();
  const all = useConfirmations();
  const pending = Object.values(all).filter((c) => c.status === 'pending' && c.expiresAt > Date.now()).length;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadRecentConfirmations().then(
      () => setError(null),
      (e: unknown) => setError(errorMessage(e)),
    );
    // The banner keeps pending ones live; refresh the history now and then for decisions made elsewhere.
    const id = setInterval(() => void loadRecentConfirmations().catch(() => undefined), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel className="flex items-center gap-2">
          {t('agents.approvals')}
          {pending > 0 && <Badge tone="alert" className="px-2! py-0! tracking-normal">{pending}</Badge>}
        </SectionLabel>
        <Button size="sm" variant="ghost" icon="activity" onClick={() => void loadPendingConfirmations().then(loadRecentConfirmations).catch(() => undefined)} aria-label={t('common.retry')}>
          <span className="sr-only">{t('common.retry')}</span>
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <ApprovalList />
    </Card>
  );
}

function sourceBadge(source: string): { label: string; tone: 'amber' | 'chip' | 'ok' } {
  const [kind, name] = source.includes(':') ? [source.slice(0, source.indexOf(':')), source.slice(source.indexOf(':') + 1)] : [source, ''];
  if (kind === 'agent' || kind === 'mcp') return { label: name ? `agent · ${name}` : 'agent', tone: 'amber' };
  if (kind === 'homekit') return { label: 'homekit', tone: 'ok' };
  return { label: name ? `${kind} · ${name}` : kind, tone: 'chip' };
}

function AuditCard() {
  const t = useT();
  const lang = useLang();
  const { devices } = useLive();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.recentCommands(50).then(
      (r) => (setRows(r), setError(null)),
      (e: unknown) => setError(errorMessage(e)),
    );
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Card className="flex flex-col gap-1">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>{t('agents.audit')}</SectionLabel>
        <Button size="sm" variant="ghost" icon="activity" onClick={load} aria-label={t('common.retry')}>
          <span className="sr-only">{t('common.retry')}</span>
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {rows === null && !error ? (
        <div className="grid place-items-center py-8 text-muted">
          <Spinner />
        </div>
      ) : rows?.length === 0 ? (
        <div className="py-4 text-sm text-muted">{t('agents.auditEmpty')}</div>
      ) : (
        rows?.map((r, i) => {
          const b = sourceBadge(r.source);
          const target = devices[r.device_id];
          const entity = target?.entities[r.endpoint_id] ?? r.device_id;
          return (
            <div key={`${r.ts}-${i}`} className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line py-2.5 text-[13px] md:grid-cols-[52px_minmax(0,1fr)_auto]">
              <span className="font-mono text-xs text-muted">{formatDateTime(r.ts, lang)}</span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Badge tone={b.tone} className="max-w-full truncate px-2! py-0.5! text-[11px]!">
                    {b.label}
                  </Badge>
                  <span className="truncate font-bold">{target?.name ?? r.device_id}</span>
                </div>
                <div className="truncate font-mono text-[11.5px] text-muted" title={r.error ?? undefined}>
                  {r.capability}.{r.command} → {entity}
                  {r.error ? ` · ${r.error}` : ''}
                </div>
              </div>
              <Badge tone={r.ok ? 'ok' : 'alert'} className="justify-self-end">
                {r.ok ? t('agents.ok') : t('agents.failed')}
              </Badge>
            </div>
          );
        })
      )}
    </Card>
  );
}

function TokensCard({ onCreated }: { onCreated: (token: string) => void }) {
  const t = useT();
  const lang = useLang();
  const { me, access } = useSession();
  // Members manage their own tokens; admins see everyone's. Guests have none.
  const canAdmin = useCan('control') && access?.canRequestApproval !== false;
  const isAdmin = useCan('admin');
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('control');
  const [riskLimit, setRiskLimit] = useState<Risk>('medium');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; info: TokenInfo } | null>(null);

  const load = useCallback(() => {
    api.tokens().then(
      (list) => (setTokens([...list].sort((a, b) => b.createdAt - a.createdAt)), setError(null)),
      (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? t('agents.tokensAdminOnly') : errorMessage(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (canAdmin) load();
    else setError(t('agents.tokensAdminOnly'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmin, load]);

  const create = () => {
    if (!name.trim()) return;
    setBusy(true);
    api.createToken(name.trim(), scope, scope === 'read' ? undefined : riskLimit).then(
      (res) => {
        setBusy(false);
        setCreated(res);
        setCreating(false);
        setName('');
        onCreated(res.token);
        load();
      },
      (e: unknown) => {
        setBusy(false);
        toast(errorMessage(e), 'error');
      },
    );
  };

  const revoke = (id: string) =>
    api.revokeToken(id).then(
      () => {
        if (created?.info.id === id) setCreated(null);
        load();
      },
      (e: unknown) => toast(errorMessage(e), 'error'),
    );

  const scopeLabel = (s: TokenScope) => t(`agents.scope.${s}`);

  return (
    <Card className="flex flex-col gap-1">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>{t('agents.tokens')}</SectionLabel>
        {canAdmin && !creating && (
          <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
            {t('common.create')}
          </Button>
        )}
      </div>

      {created && (
        <div className="mb-2 flex flex-col gap-2.5 rounded-tile bg-amber-soft p-3.5" role="status">
          <div className="flex items-start gap-2 text-[13px] leading-normal font-semibold">
            <Icon name="key" size={16} className="mt-0.5 shrink-0" />
            {t('agents.newToken')}
          </div>
          <code className="block overflow-x-auto rounded-[10px] bg-surface px-3 py-2 font-mono text-xs break-all select-all">{created.token}</code>
          <div className="flex gap-2">
            <CopyButton size="sm" text={created.token} label={t('common.copy')} copiedLabel={t('common.copied')} />
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      )}

      {creating && (
        <form
          className="mb-2 flex flex-col gap-3 rounded-tile border border-line p-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <TextField label={t('agents.tokenName')} placeholder={t('agents.tokenNamePh')} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold">{t('agents.scope')}</span>
            <Segmented<TokenScope>
              label={t('agents.scope')}
              value={scope}
              onChange={(s) => {
                setScope(s);
                // Same defaults as the server: admin may do anything, control stops at medium risk.
                setRiskLimit(s === 'admin' ? 'high' : 'medium');
              }}
              options={(isAdmin ? (['read', 'control', 'admin'] as const) : (['read', 'control'] as const)).map((s) => ({ value: s, label: scopeLabel(s) }))}
            />
          </div>
          {scope !== 'read' && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-bold">{t('agents.riskLimit')}</span>
              <Segmented<Risk>
                label={t('agents.riskLimit')}
                value={riskLimit}
                onChange={setRiskLimit}
                options={(['low', 'medium', 'high'] as const).map((r) => ({ value: r, label: t(`risk.${r}`) }))}
              />
              <span className="text-xs leading-normal text-muted">{t('agents.riskLimitHint')}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
              {t('agents.createToken')}
            </Button>
          </div>
        </form>
      )}

      {error && <div className="py-2 text-[13px] text-muted">{error}</div>}
      {tokens === null && !error && (
        <div className="grid place-items-center py-6 text-muted">
          <Spinner />
        </div>
      )}
      {tokens?.map((tk) => {
        const current = me?.id === tk.id;
        return (
          <div key={tk.id} className="flex flex-wrap items-center gap-3 border-t border-line py-3">
            <span className={cx('grid size-9 shrink-0 place-items-center rounded-[11px]', current ? 'bg-amber text-on-amber' : 'bg-chip')}>
              <Icon name="key" size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 truncate text-sm font-bold">
                {tk.name}
                {current && <Badge tone="amber">{t('agents.current')}</Badge>}
              </div>
              <div className="mt-0.5 text-[12.5px] text-muted">
                {isAdmin && tk.owner ? `${tk.owner.displayName} · ` : ''}
                {scopeLabel(tk.scope)}
                {tk.riskLimit && tk.scope !== 'read' ? ` · ${t('agents.riskUpTo', { r: t(`risk.${tk.riskLimit}`) })}` : ''} · {tk.lastUsedAt ? t('agents.lastUsed', { t: formatRelative(tk.lastUsedAt, lang) }) : t('agents.neverUsed')}
              </div>
            </div>
            {!current && <ConfirmButton size="sm" label={t('agents.revoke')} confirmLabel={t('agents.revokeConfirm')} onConfirm={() => void revoke(tk.id)} />}
          </div>
        );
      })}
    </Card>
  );
}

function ConnectCard({ url, token }: { url: string; token: string | null }) {
  const t = useT();
  const [mode, setMode] = useState<'http' | 'stdio'>('http');
  const tok = token ?? '<token>';
  const config =
    mode === 'http'
      ? { mcpServers: { livynq: { type: 'http', url, headers: { Authorization: `Bearer ${tok}` } } } }
      : { mcpServers: { livynq: { command: 'livynq', args: ['mcp'], env: { LIVYNQ_TOKEN: tok } } } };
  const snippet = JSON.stringify(config, null, 2);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>{t('agents.connect')}</SectionLabel>
        <Segmented
          size="sm"
          label={t('agents.connect')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'http', label: t('agents.http') },
            { value: 'stdio', label: t('agents.stdio') },
          ]}
        />
      </div>
      <pre className="m-0 overflow-x-auto rounded-[14px] bg-chip p-3.5 font-mono text-xs leading-relaxed whitespace-pre">{snippet}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={snippet} label={t('agents.copyConfig')} copiedLabel={t('common.copied')} />
        <span className="text-[12.5px] text-muted">{token ? t('agents.filledHint') : t('agents.placeholderHint')}</span>
      </div>
      <div className="text-[12.5px] text-muted">
        {t('agents.cliHint')} <code className="font-mono">LIVYNQ_TOKEN=… livynq mcp</code>
      </div>
    </Card>
  );
}
