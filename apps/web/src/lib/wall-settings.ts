import type { WallSettings } from '@livynq/model';
import { api } from './api.ts';
import { createStore, useStore } from './store.ts';

/** Hub-wide wall panel look. `null` until loaded. Kept live by the `settings` socket message. */
export const wallSettings = createStore<WallSettings | null>(null);

/**
 * Unsaved slider values while someone is adjusting them, so the wall behind the
 * customize sheet (and the settings preview) follows the finger before the save lands.
 */
export const wallDraft = createStore<Partial<WallSettings> | null>(null);

export const WALL_DEFAULTS: WallSettings = { background: null, cardOpacity: 0.72, backgroundBlur: 0, backgroundDim: 0.25 };

export function loadWallSettings(): Promise<void> {
  return api.uiSettings().then(
    (r) => wallSettings.set(r.wall),
    () => undefined,
  );
}

export function clearWallSettings(): void {
  wallSettings.set(null);
  wallDraft.set(null);
}

/** Saved settings with any in-progress draft applied on top. */
export function useWallLook(): WallSettings {
  const saved = useStore(wallSettings);
  const draft = useStore(wallDraft);
  return { ...WALL_DEFAULTS, ...saved, ...draft };
}

export const useWallSettings = () => useStore(wallSettings);
