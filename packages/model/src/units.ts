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

/** CIE xy <-> hue (degrees) / saturation (%) for lights that speak xy (Zigbee, Hue). Wide-gamut sRGB approximation. */

export function xyToHs(x: number, y: number): { h: number; s: number } {
  if (y <= 0) return { h: 0, s: 0 };
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b, 1e-9);
  [r, g, b] = [r / max, g / max, b / max].map((c) => Math.max(0, c)) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(((h * 60) % 360 + 360) % 360);
  const s = mx === 0 ? 0 : Math.round((d / mx) * 100);
  return { h, s };
}

export function hsToXy(hDeg: number, sPct: number): { x: number; y: number } {
  const s = sPct / 100;
  const c = s;
  const hp = (((hDeg % 360) + 360) % 360) / 60;
  const xx = c * (1 - Math.abs((hp % 2) - 1));
  const m = 1 - c;
  const [r1, g1, b1] =
    hp < 1 ? [c, xx, 0] : hp < 2 ? [xx, c, 0] : hp < 3 ? [0, c, xx] : hp < 4 ? [0, xx, c] : hp < 5 ? [xx, 0, c] : [c, 0, xx];
  const [r, g, b] = [r1 + m, g1 + m, b1 + m];
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return { x: 0.3127, y: 0.329 };
  return { x: Math.round((X / sum) * 10000) / 10000, y: Math.round((Y / sum) * 10000) / 10000 };
}
