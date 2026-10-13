/** Conversions between Matter scales and percentages used by HomeKit / UIs / MQTT. */

export const levelToPercent = (level: number): number => Math.round(((clamp(level, 1, 254) - 1) / 253) * 100);
export const percentToLevel = (pct: number): number => Math.round((clamp(pct, 0, 100) / 100) * 253) + 1;

export const hueToDegrees = (hue: number): number => Math.round((clamp(hue, 0, 254) / 254) * 360);
export const degreesToHue = (deg: number): number => Math.round((((deg % 360) + 360) % 360 / 360) * 254);
export const satToPercent = (sat: number): number => Math.round((clamp(sat, 0, 254) / 254) * 100);
export const percentToSat = (pct: number): number => Math.round((clamp(pct, 0, 100) / 100) * 254);

export const miredsToKelvin = (m: number): number => Math.round(1_000_000 / m);
export const kelvinToMireds = (k: number): number => Math.round(1_000_000 / k);

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
