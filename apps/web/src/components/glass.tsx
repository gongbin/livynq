import { createContext, useContext, type CSSProperties } from 'react';

/**
 * Set by the wall page when a background image is shown: surfaces become translucent
 * "glass" at the configured opacity. `null` everywhere else (solid surfaces).
 */
export const GlassContext = createContext<{ opacity: number } | null>(null);
export const useGlass = () => useContext(GlassContext);

/** Translucent version of a surface color (a CSS color or token) for the glass look. */
export function glassBackground(color: string | undefined, opacity: number): string {
  return `color-mix(in oklab, ${color ?? 'var(--surface)'} ${Math.round(opacity * 100)}%, transparent)`;
}

/** Style for a glass panel; pair with the `lv-glass` class (backdrop blur + hairline border). */
export function glassStyle(color: string | undefined, opacity: number): CSSProperties {
  return { background: glassBackground(color, opacity) };
}
