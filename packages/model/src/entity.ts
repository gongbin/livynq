import { getDeviceType, type EntityDomain } from './device-types.ts';

/**
 * Builds a Home Assistant style object id ("living_room_ceiling") from free text.
 * Non-ASCII names (e.g. Chinese) collapse to an empty string; callers fall back to a stable id.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export function domainForDeviceType(deviceType: string): EntityDomain {
  return getDeviceType(deviceType)?.domain ?? 'sensor';
}

/** Suggests an entity id; uniqueness is resolved by the registry. */
export function suggestEntityId(domain: EntityDomain, parts: { name: string; endpointName?: string; fallback: string }): string {
  const base = slugify([parts.name, parts.endpointName].filter(Boolean).join(' ')) || slugify(parts.fallback) || 'device';
  return `${domain}.${base}`;
}

export function isEntityId(value: string): boolean {
  return /^[a-z_]+\.[a-z0-9_]+$/.test(value);
}
