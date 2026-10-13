import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, posix } from 'node:path';
import { LivynqError, readTar } from '@livynq/core';

/** Read-only view of a Home Assistant config directory, wherever it comes from. */
export interface ConfigSource {
  readonly description: string;
  read(path: string): string | undefined;
  /** File names directly inside a directory (relative to the config root). */
  list(dir: string): string[];
}

const clean = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/|\/)+/, '');

export function directorySource(root: string): ConfigSource {
  const inside = (p: string) => {
    const full = normalize(join(root, clean(p)));
    if (!full.startsWith(normalize(root))) throw new LivynqError('INVALID_PARAMS', `Path escapes the config directory: ${p}`);
    return full;
  };
  return {
    description: root,
    read(p) {
      const full = inside(p);
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : undefined;
    },
    list(dir) {
      const full = inside(dir);
      return existsSync(full) && statSync(full).isDirectory() ? readdirSync(full).sort() : [];
    },
  };
}

/**
 * Home Assistant backups are a tar holding `homeassistant.tar.gz` (the config dir).
 * A plain tar/tar.gz of the config dir works too. Encrypted backups are not supported yet.
 */
export function backupSource(file: string): ConfigSource {
  let entries = readTar(readFileSync(file));
  const inner = entries.find((e) => /(^|\/)homeassistant\.tar\.gz$/.test(e.path));
  if (inner) {
    try {
      entries = readTar(inner.data);
    } catch {
      throw new LivynqError('NOT_SUPPORTED', 'This backup looks encrypted', 'Create an unencrypted backup, or extract it and import the config directory');
    }
  }
  const registry = entries.find((e) => e.path.endsWith('.storage/core.device_registry') || e.path.endsWith('.storage/core.entity_registry'));
  if (!registry) throw new LivynqError('INVALID_PARAMS', 'No Home Assistant .storage registry found in the archive');
  const prefix = registry.path.slice(0, registry.path.indexOf('.storage/'));
  const files = new Map(entries.filter((e) => e.type === 'file' && e.path.startsWith(prefix)).map((e) => [e.path.slice(prefix.length), e.data]));
  return {
    description: file,
    read: (p) => files.get(clean(p))?.toString('utf8'),
    list(dir) {
      const d = clean(dir).replace(/\/?$/, '/');
      const names = new Set<string>();
      for (const path of files.keys()) {
        if ((d === '/' || path.startsWith(d)) && path.length > d.length) names.add(path.slice(d === '/' ? 0 : d.length).split('/')[0]!);
      }
      return [...names].sort();
    },
  };
}

export function openSource(path: string): ConfigSource {
  if (!existsSync(path)) throw new LivynqError('NOT_FOUND', `Not found: ${path}`);
  return statSync(path).isDirectory() ? directorySource(path) : backupSource(path);
}
