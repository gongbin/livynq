import { createStore, readLocal, useStore, writeLocal } from './store.ts';

export type ThemePref = 'system' | 'light' | 'dark';
export type Lang = 'zh' | 'en';

interface Prefs {
  theme: ThemePref;
  lang: Lang;
  /** Wall (kiosk) mode forces the dark theme while active. */
  wall: boolean;
}

const storedTheme = readLocal('livynq.theme');
const storedLang = readLocal('livynq.lang');

export const prefs = createStore<Prefs>({
  theme: storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system',
  lang: storedLang === 'en' ? 'en' : 'zh',
  wall: false,
});

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;

function apply(): void {
  const { theme, lang, wall } = prefs.get();
  const root = document.documentElement;
  const effective = wall ? 'dark' : theme;
  if (effective === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', effective);
  root.lang = lang === 'zh' ? 'zh-CN' : 'en';
  const dark = effective === 'dark' || (effective === 'system' && Boolean(media?.matches));
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = dark ? '#1d1a17' : '#f6f3ee';
  }
}

prefs.subscribe(apply);
media?.addEventListener('change', apply);
apply();

export function setTheme(theme: ThemePref): void {
  writeLocal('livynq.theme', theme === 'system' ? null : theme);
  prefs.set((p) => ({ ...p, theme }));
}

export function setLang(lang: Lang): void {
  writeLocal('livynq.lang', lang);
  prefs.set((p) => ({ ...p, lang }));
}

export function setWall(wall: boolean): void {
  prefs.set((p) => ({ ...p, wall }));
}

/** The theme actually shown, resolving "system". */
export function useResolvedTheme(): 'light' | 'dark' {
  const p = useStore(prefs);
  if (p.wall) return 'dark';
  if (p.theme !== 'system') return p.theme;
  return media?.matches ? 'dark' : 'light';
}

export const usePrefs = () => useStore(prefs);
