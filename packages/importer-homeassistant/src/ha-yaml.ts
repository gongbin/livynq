import { posix } from 'node:path';
import { parse, type ScalarTag } from 'yaml';
import type { ConfigSource } from './source.ts';

export interface YamlWarning {
  file: string;
  message: string;
}

/**
 * Loads Home Assistant YAML with its custom tags:
 * !include, !include_dir_list, !include_dir_merge_list, !include_dir_named, !include_dir_merge_named,
 * !secret (from secrets.yaml), !env_var (never resolved: environment values are not imported), !input (kept as a marker).
 */
export function loadHaYaml(source: ConfigSource, file: string, warnings: YamlWarning[] = [], depth = 0): unknown {
  const text = source.read(file);
  if (text === undefined) {
    warnings.push({ file, message: 'file not found' });
    return undefined;
  }
  if (depth > 10) {
    warnings.push({ file, message: 'include depth exceeded' });
    return undefined;
  }
  const dir = posix.dirname(file);
  const rel = (p: string) => posix.normalize(posix.join(dir, p.trim()));
  const yamlFiles = (d: string) => source.list(rel(d)).filter((n) => /\.ya?ml$/.test(n) && !n.startsWith('.')).map((n) => posix.join(rel(d), n));
  const load = (p: string) => loadHaYaml(source, p, warnings, depth + 1);
  let secrets: Record<string, unknown> | undefined;

  const tags: ScalarTag[] = [
    { tag: '!include', resolve: (v) => load(rel(v)) as never },
    { tag: '!include_dir_list', resolve: (v) => yamlFiles(v).map(load) as never },
    { tag: '!include_dir_merge_list', resolve: (v) => yamlFiles(v).flatMap((f) => [load(f)].flat().filter((x) => x !== undefined && x !== null)) as never },
    { tag: '!include_dir_named', resolve: (v) => Object.fromEntries(yamlFiles(v).map((f) => [posix.basename(f).replace(/\.ya?ml$/, ''), load(f)])) as never },
    { tag: '!include_dir_merge_named', resolve: (v) => Object.assign({}, ...yamlFiles(v).map((f) => (load(f) as object) ?? {})) as never },
    {
      tag: '!secret',
      resolve: (v) => {
        secrets ??= (loadHaYaml(source, 'secrets.yaml', [], depth + 1) as Record<string, unknown>) ?? {};
        if (!(v in secrets)) warnings.push({ file, message: `secret "${v}" not found` });
        return secrets[v] as never;
      },
    },
    {
      tag: '!env_var',
      resolve: (v) => {
        warnings.push({ file, message: `!env_var ${v} is not imported` });
        return undefined as never;
      },
    },
    { tag: '!input', resolve: (v) => ({ '!input': v }) as never },
  ];
  try {
    return parse(text, { customTags: tags, merge: true, uniqueKeys: false, logLevel: 'error' });
  } catch (err) {
    warnings.push({ file, message: `YAML error: ${(err as Error).message.split('\n')[0]}` });
    return undefined;
  }
}
