/**
 * Sunrise / sunset using the NOAA solar position algorithm (accurate to about a minute),
 * so the hub needs no network service or extra dependency.
 */
export interface Location {
  latitude: number;
  longitude: number;
}

const rad = Math.PI / 180;

/** Sun event for the local calendar day containing `day`; undefined during polar day/night. */
export function sunEvent(event: 'sunrise' | 'sunset', day: Date, loc: Location): Date | undefined {
  // Julian day at local noon of the requested date, expressed in UTC.
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const jd = noon.getTime() / 86_400_000 + 2440587.5;
  const t = (jd - 2451545) / 36525;

  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * rad) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad)) / rad;
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    4 / rad *
    (y * Math.sin(2 * l0 * rad) - 2 * e * Math.sin(m * rad) + 4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad) - 0.5 * y * y * Math.sin(4 * l0 * rad) - 1.25 * e * e * Math.sin(2 * m * rad));

  const cosHa = (Math.cos(90.833 * rad) - Math.sin(loc.latitude * rad) * Math.sin(decl * rad)) / (Math.cos(loc.latitude * rad) * Math.cos(decl * rad));
  if (cosHa < -1 || cosHa > 1) return undefined;
  const ha = Math.acos(cosHa) / rad;
  const solarNoonMin = 720 - 4 * loc.longitude - eqTime; // minutes after UTC midnight
  const minutes = event === 'sunrise' ? solarNoonMin - 4 * ha : solarNoonMin + 4 * ha;
  const utcMidnight = Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate());
  return new Date(utcMidnight + minutes * 60_000);
}

/** Next occurrence of a sun event (plus offset) strictly after `from`. */
export function nextSunEvent(event: 'sunrise' | 'sunset', offsetMs: number, from: Date, loc: Location): Date | undefined {
  for (let i = -1; i <= 366; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, 12);
    const at = sunEvent(event, day, loc);
    if (at && at.getTime() + offsetMs > from.getTime()) return new Date(at.getTime() + offsetMs);
  }
  return undefined;
}
