import type { SystemInfo, TokenScope } from '@livynq/model';
import { api, type Me, type TokenInfo, type User } from './api.ts';
import { createStore, useStore } from './store.ts';

interface Session {
  /** The token with its effective scope (capped by the user's role) */
  me: TokenInfo | null;
  user: User | null;
  access: Me['access'] | null;
  info: SystemInfo | null;
}

export const session = createStore<Session>({ me: null, user: null, access: null, info: null });
export const useSession = () => useStore(session);

export async function loadSession(): Promise<void> {
  const [me, info] = await Promise.all([api.me(), api.systemInfo()]);
  session.set({ me: me.token, user: me.user, access: me.access, info });
}

export function clearSession(): void {
  session.set({ me: null, user: null, access: null, info: null });
}

const rank: Record<TokenScope, number> = { read: 0, control: 1, admin: 2 };

/** Whether the signed-in token may do something requiring `scope`. Unknown → allow; the server decides. */
export function useCan(scope: TokenScope): boolean {
  const { me } = useSession();
  return !me || rank[me.scope] >= rank[scope];
}

/** Guests (and other room-restricted accounts) see part of the home. */
export function useRestricted(): { rooms: boolean; automations: boolean; approvals: boolean } {
  const { access } = useSession();
  return { rooms: Boolean(access?.rooms), automations: access?.automations === false, approvals: access?.canRequestApproval === false };
}
