import type { ConfirmationDTO } from '@livynq/model';
import { api } from './api.ts';
import { createStore, useStore } from './store.ts';

/**
 * Human approvals for risky commands (agents, scripts, limited tokens).
 * Keyed by id; filled from REST on (re)connect and kept live by `confirmation` socket messages.
 */
export const confirmations = createStore<Record<string, ConfirmationDTO>>({});
export const useConfirmations = () => useStore(confirmations);

type Listener = (next: ConfirmationDTO, previous: ConfirmationDTO | undefined) => void;
const listeners = new Set<Listener>();

/** Notified for every live change (not for bulk loads), e.g. to toast a decision. */
export function onConfirmationChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function upsertConfirmation(c: ConfirmationDTO, notify = true): void {
  const previous = confirmations.get()[c.id];
  confirmations.set((all) => ({ ...all, [c.id]: c }));
  if (notify) for (const l of listeners) l(c, previous);
}

function merge(list: ConfirmationDTO[]): void {
  confirmations.set((all) => {
    const next = { ...all };
    for (const c of list) next[c.id] = c;
    return next;
  });
}

/** Pending ones: needed everywhere (banner). */
export function loadPendingConfirmations(): Promise<void> {
  return api.confirmations('pending').then(
    (list) =>
      confirmations.set((all) => {
        // Anything we thought was pending but the server no longer lists was decided while we were away.
        const next = { ...all };
        const live = new Set(list.map((c) => c.id));
        for (const c of Object.values(next)) if (c.status === 'pending' && !live.has(c.id)) delete next[c.id];
        for (const c of list) next[c.id] = c;
        return next;
      }),
    () => undefined,
  );
}

/** Recent history including decided ones (Agents page). */
export function loadRecentConfirmations(): Promise<void> {
  return api.confirmations().then(merge);
}

export function clearConfirmations(): void {
  confirmations.set({});
}

export function sortConfirmations(list: ConfirmationDTO[]): ConfirmationDTO[] {
  return [...list].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt - a.createdAt);
}

/** A command that the server queued for approval instead of running it. Not an error for the user. */
export class AwaitingApproval extends Error {
  readonly confirmationId: string;
  constructor(confirmationId: string, message: string) {
    super(message);
    this.name = 'AwaitingApproval';
    this.confirmationId = confirmationId;
  }
}
