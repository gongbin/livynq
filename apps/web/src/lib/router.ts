import { useSyncExternalStore } from 'react';

export const routes = ['home', 'devices', 'rooms', 'automations', 'agents', 'migrate', 'ecosystems', 'plugins', 'settings', 'more', 'wall'] as const;
export type Route = (typeof routes)[number];

/** Tiny hash router: `#/devices` → 'devices'. Unknown paths fall back to home. */
function current(): Route {
  const path = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (routes as readonly string[]).includes(path) ? (path as Route) : 'home';
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current, current);
}

export const href = (route: Route) => `#/${route}`;

/** Path segments after the route, e.g. `#/automations/x/edit` → ['x', 'edit']; query string excluded. */
function subPath(): string {
  return location.hash.replace(/^#\/?/, '').split('?')[0]!.split('/').slice(1).map(decodeURIComponent).join('/');
}

export function useSubPath(): string[] {
  const path = useSyncExternalStore(subscribe, subPath, subPath);
  return path ? path.split('/') : [];
}

/** Query parameters after `?` in the hash, e.g. `#/automations/new?template=motion`. */
export function hashQuery(): URLSearchParams {
  const i = location.hash.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : location.hash.slice(i + 1));
}

/** Navigates to an arbitrary hash path such as `/automations/x`. */
export function go(path: string): void {
  location.hash = path;
}

export function navigate(route: Route): void {
  if (current() !== route || !location.hash) location.hash = `/${route}`;
}
