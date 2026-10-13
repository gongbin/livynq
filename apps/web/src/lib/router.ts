import { useSyncExternalStore } from 'react';

export const routes = ['home', 'devices', 'rooms', 'automations', 'agents', 'migrate', 'ecosystems', 'settings', 'more', 'wall'] as const;
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

export function navigate(route: Route): void {
  if (current() !== route || !location.hash) location.hash = `/${route}`;
}
