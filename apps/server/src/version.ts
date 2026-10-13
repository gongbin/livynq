import { readFileSync } from 'node:fs';

// Injected by the single-executable build; read from package.json otherwise.
declare const __LIVYNQ_VERSION__: string | undefined;

export const VERSION: string =
  typeof __LIVYNQ_VERSION__ === 'string'
    ? __LIVYNQ_VERSION__
    : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
