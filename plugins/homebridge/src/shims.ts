import { APIEvent, LogLevel, PlatformAccessory, PlatformAccessoryEvent, PluginType, SERVER_VERSION } from './api.ts';
import { hap } from './hap.ts';

/**
 * Homebridge plugins `require('hap-nodejs')` / `require('homebridge')` (mostly for enums and
 * classes). Installed plugins get tiny packages of those names that hand out this process's
 * objects, so every plugin shares one hap-nodejs (instanceof checks across plugins hold).
 */

const KEY = Symbol.for('livynq.homebridge');
const IDENT = /^[A-Za-z_$][\w$]*$/;

function homebridgeExports(): Record<string, unknown> {
  return { ...hap, APIEvent, PlatformAccessoryEvent, PluginType, LogLevel, PlatformAccessory };
}

/** Publishes the shared objects (call before loading any Homebridge plugin). */
export function provideHomebridge(): void {
  (globalThis as Record<symbol, unknown>)[KEY] = { 'hap-nodejs': hap, homebridge: homebridgeExports() };
}

const hapVersion = () => {
  try {
    return (hap as unknown as { HAPLibraryVersion?: () => string }).HAPLibraryVersion?.() ?? '0.14.3';
  } catch {
    return '0.14.3';
  }
};

/** CommonJS with one `exports.X =` line per name, so ESM `import { X }` works too (cjs-module-lexer). */
function shim(name: 'hap-nodejs' | 'homebridge', version: string, names: string[]): { name: string; files: Record<string, string> } {
  const code = [
    `// Provided by Livynq's Homebridge compatibility layer. Generated; do not edit.`,
    `'use strict';`,
    `const m = globalThis[Symbol.for('livynq.homebridge')]?.[${JSON.stringify(name)}];`,
    `if (!m) throw new Error(${JSON.stringify(`${name}: this plugin must be loaded by Livynq's Homebridge plugin`)});`,
    ...names.map((n) => `exports.${n} = m.${n};`),
    '',
  ].join('\n');
  const pkg = { name, version, main: 'index.js', livynqShim: true };
  return { name, files: { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'index.js': code } };
}

export function homebridgeShims(): { name: string; files: Record<string, string> }[] {
  const names = (o: Record<string, unknown>) => Object.keys(o).filter((k) => k !== 'default' && k !== '__esModule' && IDENT.test(k)).sort();
  return [shim('hap-nodejs', hapVersion(), names(hap as unknown as Record<string, unknown>)), shim('homebridge', SERVER_VERSION, names(homebridgeExports()))];
}
