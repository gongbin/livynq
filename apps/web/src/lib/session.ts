import type { SystemInfo, TokenScope } from '@livynq/model';
import { api, type TokenInfo } from './api.ts';
import { createStore, useStore } from './store.ts';

interface Session {
  me: TokenInfo | null;
  info: SystemInfo | null;
}

export const session = createStore<Session>({ me: null, info: null });
export const useSession = () => useStore(session);

export async function loadSession(): Promise<void> {
  const [me, info] = await Promise.all([api.me(), api.systemInfo()]);
  session.set({ me: me.token, info });
}

export function clearSession(): void {
  session.set({ me: null, info: null });
}

const rank: Record<TokenScope, number> = { read: 0, control: 1, admin: 2 };

/** Whether the signed-in token may do something requiring `scope`. Unknown → allow; the server decides. */
export function useCan(scope: TokenScope): boolean {
  const { me } = useSession();
  return !me || rank[me.scope] >= rank[scope];
}
