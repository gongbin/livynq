import { useMemo } from 'react';
import { api, errorMessage, type AutomationInfo } from './api.ts';
import { entityIndex, type SummaryCtx } from './automation.ts';
import { useLang, useT } from './i18n.ts';
import { useLive } from './live.ts';
import { createStore, useStore } from './store.ts';

interface AutomationsState {
  list: AutomationInfo[] | null;
  error: string | null;
}

/** Automations as last fetched; pages call `reloadAutomations()` after every mutation. */
export const automations = createStore<AutomationsState>({ list: null, error: null });
export const useAutomations = () => useStore(automations);

const byAlias = (a: AutomationInfo, b: AutomationInfo) => a.alias.localeCompare(b.alias);

let inflight: Promise<void> | null = null;

export function reloadAutomations(): Promise<void> {
  inflight ??= api.automations().then(
    (list) => {
      inflight = null;
      automations.set({ list: [...list].sort(byAlias), error: null });
    },
    (e: unknown) => {
      inflight = null;
      automations.set((s) => ({ ...s, error: errorMessage(e) }));
    },
  );
  return inflight;
}

/** Replaces one automation in the store with a fresh copy from a mutation response. */
export function putAutomation(info: AutomationInfo): void {
  automations.set((s) => {
    const rest = (s.list ?? []).filter((a) => a.id !== info.id);
    return { ...s, list: [...rest, info].sort(byAlias) };
  });
}

export function dropAutomation(id: string): void {
  automations.set((s) => ({ ...s, list: s.list?.filter((a) => a.id !== id) ?? null }));
}

/** Names for entities, devices and rooms, used by the summarizer. */
export function useSummaryCtx(): SummaryCtx {
  const t = useT();
  const lang = useLang();
  const { devices, rooms } = useLive();
  // `t` is recreated every render; the index only depends on devices and language.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entities = useMemo(() => entityIndex(devices, t), [devices, lang]);
  return { t, lang, entities, devices, rooms };
}
