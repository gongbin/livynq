import { useEffect, useState } from 'react';
import { api, errorMessage, logout, type Role, type User } from '../lib/api.ts';
import { formatRelative } from '../lib/format.ts';
import { useLang, useT, type MessageKey } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { loadSession, useCan, useSession } from '../lib/session.ts';
import { confirmDialog } from './dialog.tsx';
import { Icon } from './icons.tsx';
import { Sheet } from './sheet.tsx';
import { toast } from './toast.tsx';
import { Badge, Button, Card, ErrorNote, IconButton, SectionLabel, SelectField, Switch, TextField, cx } from './ui.tsx';

const ROLE_TONE: Record<Role, 'amber' | 'ok' | 'chip'> = {
  owner: 'amber',
  admin: 'ok',
  member: 'chip',
  guest: 'chip',
};

export function RoleBadge({ role }: { role: Role }) {
  const t = useT();
  return <Badge tone={ROLE_TONE[role]}>{t(`users.role.${role}` as MessageKey)}</Badge>;
}

/** Settings → My account: who is signed in, password, sign out (everywhere). */
export function AccountCard() {
  const t = useT();
  const { me, user } = useSession();
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = async () => {
    setBusy('pw');
    setError(null);
    try {
      await api.changePassword(current, next);
      toast(t('users.passwordChanged'));
      setChanging(false);
      setCurrent('');
      setNext('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="flex flex-col gap-3">
      <SectionLabel>{t('users.account')}</SectionLabel>
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-full bg-amber-soft text-[15px] font-extrabold text-amber-ink">{(user?.displayName ?? me?.name ?? '?').slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">
            {user ? user.displayName : (me?.name ?? '—')} {user ? <RoleBadge role={user.role} /> : me && <Badge className="ml-1">{t(`agents.scope.${me.scope}`)}</Badge>}
          </div>
          <div className="truncate text-xs text-muted">{user ? `@${user.username}` : t('users.tokenSession')}</div>
        </div>
        <Button icon="logOut" onClick={() => void logout()}>
          {t('settings.signOut')}
        </Button>
      </div>
      {user && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button size="sm" icon="key" onClick={() => setChanging((v) => !v)}>
            {t('users.changePassword')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="logOut"
            onClick={async () => {
              if (
                !(await confirmDialog({
                  title: t('users.signOutAllConfirm'),
                  confirmLabel: t('users.signOutAll'),
                  icon: 'logOut',
                }))
              )
                return;
              await api.logoutAll().catch((e: unknown) => toast(errorMessage(e), 'error'));
              await logout();
            }}
          >
            {t('users.signOutAll')}
          </Button>
        </div>
      )}
      {changing && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (current && next.length >= 8) void change();
          }}
        >
          <TextField label={t('users.currentPassword')} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          <TextField label={t('users.newPassword')} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" hint={t('users.passwordHint')} />
          {error && <ErrorNote>{error}</ErrorNote>}
          <div>
            <Button type="submit" variant="amber" busy={busy === 'pw'} disabled={!current || next.length < 8}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Settings → Users (admins). */
export function UsersCard() {
  const t = useT();
  const lang = useLang();
  const canAdmin = useCan('admin');
  const { user: me } = useSession();
  const { rooms } = useLive();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | 'new' | null>(null);

  const load = async () => {
    try {
      setUsers(await api.users());
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (canAdmin) void load();
  }, [canAdmin]);
  if (!canAdmin) return null;

  const roomNames = (ids: string[] | null) => (ids === null ? t('users.allRooms') : ids.length ? ids.map((id) => rooms.find((r) => r.id === id)?.name ?? id).join(', ') : t('users.noRooms'));

  return (
    <Card className="flex flex-col gap-3 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionLabel>{t('users.title')}</SectionLabel>
          <p className="mt-1.5 mb-0 text-[13px] leading-relaxed text-pretty text-muted">{t('users.subtitle')}</p>
        </div>
        <Button variant="amber" icon="plus" onClick={() => setEditing('new')}>
          {t('users.add')}
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {users && users.length === 0 && <p className="m-0 text-[13px] text-muted">{t('users.none')}</p>}
      {users && users.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => setEditing(u)}
                className={cx('flex w-full items-center gap-3 rounded-[15px] border-0 bg-surface2 p-2.5 pr-3 text-left text-ink transition-colors hover:bg-chip', u.disabled && 'opacity-60')}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-chip text-[14px] font-extrabold">{u.displayName.slice(0, 1).toUpperCase()}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-bold">
                    <span className="truncate">{u.displayName}</span>
                    <RoleBadge role={u.role} />
                    {u.id === me?.id && <Badge>{t('users.you')}</Badge>}
                    {u.disabled && <Badge tone="alert">{t('users.disabled')}</Badge>}
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    @{u.username}
                    {u.role === 'member' || u.role === 'guest' ? ` · ${roomNames(u.allowedRooms)}` : ''} ·{' '}
                    {u.lastLoginAt
                      ? t('users.lastLogin', {
                          t: formatRelative(u.lastLoginAt, lang),
                        })
                      : t('users.neverLoggedIn')}
                  </span>
                </span>
                <Icon name="chevronRight" size={16} className="shrink-0 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <UserSheet
          user={editing === 'new' ? null : editing}
          me={me}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            await loadSession().catch(() => undefined);
          }}
        />
      )}
    </Card>
  );
}

function UserSheet({ user, me, onClose, onSaved }: { user: User | null; me: User | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT();
  const { rooms } = useLive();
  const isNew = user === null;
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(user?.role ?? 'member');
  const [limited, setLimited] = useState(user ? user.allowedRooms !== null : false);
  const [allowed, setAllowed] = useState<Set<string>>(new Set(user?.allowedRooms ?? []));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const owner = user?.role === 'owner';
  // Admins can't change admins; only the owner can make admins.
  const canEdit = !me || me.role === 'owner' || (user ? user.role === 'member' || user.role === 'guest' : true);
  const roleOptions: Role[] = owner ? ['owner'] : !me || me.role === 'owner' ? ['admin', 'member', 'guest'] : ['member', 'guest'];
  const restrictable = role === 'member' || role === 'guest';
  const roomsValue = restrictable && (role === 'guest' || limited) ? [...allowed] : null;
  const ready = isNew ? username.trim().length >= 2 && password.length >= 8 : true;

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (done) toast(done);
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const save = () =>
    run(
      'save',
      () =>
        isNew
          ? api.createUser({
              username: username.trim(),
              displayName: displayName.trim() || undefined,
              password,
              role,
              allowedRooms: roomsValue,
            })
          : api.updateUser(user.id, {
              displayName: displayName.trim(),
              ...(owner ? {} : { role, allowedRooms: roomsValue }),
            }),
      isNew ? t('users.added', { name: displayName.trim() || username.trim() }) : t('users.saved'),
    );

  return (
    <Sheet label={isNew ? t('users.add') : user.displayName} onClose={onClose}>
      <div className="flex flex-col gap-4 p-5 md:p-6">
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 truncate text-xl font-extrabold tracking-[-0.015em]">{isNew ? t('users.add') : user.displayName}</h2>
          {user && <RoleBadge role={user.role} />}
          <IconButton icon="x" label={t('common.close')} onClick={onClose} />
        </div>
        {!canEdit && <ErrorNote>{t('users.ownerOnly')}</ErrorNote>}
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && canEdit && !busy) void save();
          }}
        >
          {isNew && (
            <TextField
              label={t('users.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
              autoComplete="off"
              hint={t('users.usernameHint')}
            />
          )}
          <TextField label={t('users.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username || t('users.displayNamePh')} disabled={!canEdit} />
          {isNew && (
            <TextField label={t('users.tempPassword')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" hint={t('users.tempPasswordHint')} />
          )}
          <SelectField
            label={t('users.roleLabel')}
            value={role}
            onChange={(v) => setRole(v as Role)}
            disabled={!canEdit || owner}
            options={roleOptions.map((r) => ({
              value: r,
              label: `${t(`users.role.${r}` as MessageKey)} — ${t(`users.roleDesc.${r}` as MessageKey)}`,
            }))}
          />
          {restrictable && (
            <div className="flex flex-col gap-2.5 rounded-[14px] bg-surface2 p-3.5">
              {role === 'member' && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-bold">{t('users.limitRooms')}</span>
                  <Switch checked={limited} onChange={setLimited} label={t('users.limitRooms')} disabled={!canEdit} />
                </div>
              )}
              {(role === 'guest' || limited) && (
                <>
                  <span className="text-[12.5px] text-muted">{role === 'guest' ? t('users.guestRooms') : t('users.memberRooms')}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {rooms.map((r) => {
                      const on = allowed.has(r.id);
                      return (
                        <button
                          key={r.id}
                          type="button"
                          disabled={!canEdit}
                          aria-pressed={on}
                          onClick={() =>
                            setAllowed((s) => {
                              const n = new Set(s);
                              if (on) n.delete(r.id);
                              else n.add(r.id);
                              return n;
                            })
                          }
                          className={cx(
                            'rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors',
                            on ? 'border-amber bg-amber-soft text-ink' : 'border-line bg-surface text-muted',
                          )}
                        >
                          {on && <Icon name="check" size={12} className="mr-1 inline" />}
                          {r.name}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
          {canEdit && (
            <div>
              <Button type="submit" variant="amber" icon="check" busy={busy === 'save'} disabled={!ready}>
                {isNew ? t('users.create') : t('common.save')}
              </Button>
            </div>
          )}
        </form>
        {user && canEdit && (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <SectionLabel>{t('users.manage')}</SectionLabel>
            <div className="flex flex-wrap gap-2">
              <ResetPassword user={user} onDone={onSaved} />
              {!owner && user.id !== me?.id && (
                <Button size="sm" icon={user.disabled ? 'power' : 'lock'} busy={busy === 'disable'} onClick={() => void run('disable', () => api.updateUser(user.id, { disabled: !user.disabled }))}>
                  {user.disabled ? t('users.enable') : t('users.disable')}
                </Button>
              )}
              {me?.role === 'owner' && !owner && !user.disabled && (
                <Button
                  size="sm"
                  icon="key"
                  busy={busy === 'owner'}
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: t('users.transferConfirm', {
                          name: user.displayName,
                        }),
                        body: t('users.transferBody'),
                        confirmLabel: t('users.transfer'),
                        icon: 'key',
                      }))
                    )
                      return;
                    await run('owner', () => api.transferOwnership(user.id), t('users.transferred'));
                  }}
                >
                  {t('users.transfer')}
                </Button>
              )}
              {!owner && user.id !== me?.id && (
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  busy={busy === 'delete'}
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: t('users.deleteConfirm', {
                          name: user.displayName,
                        }),
                        body: t('users.deleteBody'),
                        confirmLabel: t('users.delete'),
                        danger: true,
                        icon: 'trash',
                      }))
                    )
                      return;
                    await run('delete', () => api.deleteUser(user.id), t('users.deleted'));
                  }}
                >
                  {t('users.delete')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function ResetPassword({ user, onDone }: { user: User; onDone: () => Promise<void> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="sm" icon="key" onClick={() => setOpen(true)}>
        {t('users.resetPassword')}
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (password.length < 8) return;
        setBusy(true);
        setError(null);
        try {
          await api.resetPassword(user.id, password);
          toast(t('users.passwordReset', { name: user.displayName }));
          setOpen(false);
          await onDone();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField label={t('users.tempPassword')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" hint={t('users.resetHint')} />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="amber" busy={busy} disabled={password.length < 8}>
          {t('users.resetPassword')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
