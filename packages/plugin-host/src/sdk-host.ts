import * as model from '@livynq/model';
import * as sdk from '@livynq/sdk';

/**
 * Installed plugins share the hub's SDK instead of carrying their own copy: the installer writes
 * small shim packages for @livynq/sdk and @livynq/model into each plugin's node_modules that
 * re-export what the hub publishes here. A plugin therefore always runs against the SDK of the
 * hub that loads it (also inside the single-file binary, which has no SDK files on disk).
 */

const KEY = Symbol.for('livynq.plugin-sdk');

/** Publishes the SDK for shims; called before any plugin module is imported (hub and plugin host process). */
export function provideSdk(): void {
  (globalThis as Record<symbol, unknown>)[KEY] = { '@livynq/sdk': sdk, '@livynq/model': model };
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Shim packages (name → files) to write into node_modules/<name>. */
export function sdkShims(version: string): { name: '@livynq/sdk' | '@livynq/model'; files: Record<string, string> }[] {
  return (
    [
      ['@livynq/sdk', sdk],
      ['@livynq/model', model],
    ] as const
  ).map(([name, mod]) => {
    const names = Object.keys(mod).filter((k) => k !== 'default' && IDENT.test(k)).sort();
    const code = [
      `// Provided by the Livynq hub (${version}): plugins share the hub's ${name}. Generated; do not edit.`,
      `const m = globalThis[Symbol.for('livynq.plugin-sdk')]?.[${JSON.stringify(name)}];`,
      `if (!m) throw new Error(${JSON.stringify(`${name}: this plugin must be loaded by Livynq`)});`,
      names.length ? `export const { ${names.join(', ')} } = m;` : '',
      '',
    ].join('\n');
    const pkg = { name, version, type: 'module', exports: { '.': './index.js' }, livynqShim: true };
    return { name, files: { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'index.js': code } };
  });
}
