import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import semver from 'semver';
import { readTar } from '@livynq/core';
import { sdkShims } from '@livynq/plugin-host';

/**
 * Installs plugins from an npm registry (or an uploaded .tgz) without npm, so it also works in
 * the single-file binary and the Home Assistant add-on:
 *
 * - every plugin gets a self-contained tree: <plugins>/node_modules/<name>/ holds the package and
 *   its own node_modules (hoisted where possible, nested on version conflicts), so installing,
 *   upgrading and removing one plugin never touches another;
 * - every tarball is checked against the registry's integrity hash; links and paths escaping the
 *   package directory are refused;
 * - install scripts are never run (packages that ship prebuilt native binaries still work);
 * - @livynq/sdk and @livynq/model are not downloaded: small shims re-export the hub's own copy.
 */

export type PackageSource = { spec: string } | { tarball: Buffer; filename?: string };

export interface PackageInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
}

export interface ResolvedPlugin {
  root: PackageInfo & { hasInstallScript: boolean };
  /** Every package of the tree except the root, with its place in the plugin's node_modules. */
  packages: { name: string; version: string; path: string; hasInstallScript: boolean }[];
  /** @livynq/sdk ranges the tree asks for, and whether this hub satisfies them. */
  sdk: { ranges: string[]; provided: string; compatible: boolean };
  warnings: string[];
  /** Where it came from, as recorded for upgrades. */
  source: 'registry' | 'file';
  spec: string;
}

export interface InstalledRecord {
  name: string;
  version: string;
  source: 'registry' | 'file';
  spec: string;
  installedAt: number;
  packages: number;
}

export interface InstallerOptions {
  /** <dataDir>/plugins */
  dir: string;
  /** Hub version: the SDK version the shims provide. */
  hubVersion: string;
  registry?: string;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
}

interface VersionManifest {
  name: string;
  version: string;
  description?: string;
  author?: string | { name?: string };
  license?: string;
  homepage?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  os?: string[];
  cpu?: string[];
  hasInstallScript?: boolean;
  scripts?: Record<string, string>;
  dist?: { tarball: string; integrity?: string; shasum?: string };
}

interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, VersionManifest>;
}

interface Node {
  /** Folder name in node_modules (differs from the package name for npm: aliases) */
  folder: string;
  manifest: VersionManifest;
  /** '' for the plugin itself, else e.g. 'node_modules/a/node_modules/b' */
  path: string;
}

const SDK = new Set(['@livynq/sdk', '@livynq/model']);
const NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const MAX_PACKAGES = 3000;
const MAX_TARBALL = 200 * 1024 * 1024;

export class InstallError extends Error {}

/** <dataDir>/plugins (a temp dir for in-memory homes). */
export function pluginsDir(dataDir: string): string {
  return dataDir === ':memory:' ? join(tmpdir(), `livynq-plugins-${process.pid}`) : join(dataDir, 'plugins');
}

export function parseSpec(spec: string): { name: string; range: string } {
  const s = spec.trim();
  const at = s.indexOf('@', 1);
  const name = at > 0 ? s.slice(0, at) : s;
  const range = at > 0 ? s.slice(at + 1) || 'latest' : 'latest';
  if (!NAME.test(name)) throw new InstallError(`"${spec}" is not an npm package name`);
  return { name, range };
}

const authorOf = (a: VersionManifest['author']) => (typeof a === 'string' ? a : a?.name);
const scriptsInstall = (m: VersionManifest) => Boolean(m.hasInstallScript || m.scripts?.preinstall || m.scripts?.install || m.scripts?.postinstall);

/** npm's os/cpu fields: allow-lists, with "!x" negations. */
function platformOk(list: string[] | undefined, value: string): boolean {
  if (!list?.length) return true;
  const deny = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1));
  const allow = list.filter((v) => !v.startsWith('!'));
  return !deny.includes(value) && (!allow.length || allow.includes(value));
}

function integrityOk(data: Buffer, dist: { integrity?: string; shasum?: string } | undefined): boolean {
  if (dist?.integrity) {
    const sums = dist.integrity.split(/\s+/).filter(Boolean);
    for (const s of sums) {
      const [algo, digest] = [s.slice(0, s.indexOf('-')), s.slice(s.indexOf('-') + 1)];
      if (algo === 'sha512' || algo === 'sha384' || algo === 'sha256' || algo === 'sha1') {
        if (createHash(algo).update(data).digest('base64') === digest) return true;
      }
    }
    return false;
  }
  if (dist?.shasum) return createHash('sha1').update(data).digest('hex') === dist.shasum;
  return false;
}

/** Extracts an npm tarball (first path component stripped) into dir, refusing links and escapes. */
export function extractPackage(data: Buffer, dir: string): void {
  let entries;
  try {
    entries = readTar(data, { links: true });
  } catch (err) {
    throw new InstallError(`not a valid package archive: ${(err as Error).message}`);
  }
  if (!entries.length) throw new InstallError('the package archive is empty');
  for (const e of entries) {
    const rel = e.path.split('/').slice(1).join('/');
    if (!rel) continue;
    if (e.type === 'symlink' || e.type === 'link') throw new InstallError(`refusing the link ${e.path} → ${e.linkTarget ?? ''} in the package`);
    const norm = posix.normalize(rel);
    if (norm.startsWith('..') || posix.isAbsolute(norm) || norm.includes('\0') || /^[a-zA-Z]:/.test(norm)) throw new InstallError(`refusing the path ${e.path} (outside the package)`);
    const target = join(dir, ...norm.split('/'));
    if (e.type === 'dir') mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data, { mode: (e.mode & 0o755) | 0o644 });
    }
  }
}

export class PluginInstaller {
  readonly dir: string;
  readonly #o: Required<Omit<InstallerOptions, 'dir'>>;
  readonly #latest = new Map<string, { at: number; version: string | null }>();

  constructor(options: InstallerOptions) {
    this.dir = options.dir;
    this.#o = {
      hubVersion: options.hubVersion,
      registry: (options.registry ?? 'https://registry.npmjs.org').replace(/\/$/, ''),
      fetch: options.fetch ?? fetch,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
    };
  }

  get registry(): string {
    return this.#o.registry;
  }

  packageDir(name: string): string {
    return join(this.dir, 'node_modules', ...name.split('/'));
  }

  installed(): Record<string, InstalledRecord> {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'installed.json'), 'utf8')) as Record<string, InstalledRecord>;
    } catch {
      return {};
    }
  }

  #saveInstalled(records: Record<string, InstalledRecord>): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'installed.json'), `${JSON.stringify(records, null, 2)}\n`);
  }

  /** Version of a package installed under <plugins>/node_modules (also ones put there by npm). */
  installedVersion(name: string): string | null {
    try {
      return (JSON.parse(readFileSync(join(this.packageDir(name), 'package.json'), 'utf8')) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- registry

  /** Fetches a packument; `cache` lives for one resolution so new publishes are always seen. */
  #packument(name: string, full = false, cache = new Map<string, Promise<Packument>>()): Promise<Packument> {
    const key = `${full ? 'full:' : ''}${name}`;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const url = `${this.#o.registry}/${name.replace('/', '%2f')}`;
        let res: Response;
        try {
          res = await this.#o.fetch(url, {
            headers: { accept: full ? 'application/json' : 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          throw new InstallError(`cannot reach the package registry (${this.#o.registry}): ${(err as Error).message}`);
        }
        if (res.status === 404) throw new InstallError(`${name} was not found on ${this.#o.registry}`);
        if (!res.ok) throw new InstallError(`${this.#o.registry} answered HTTP ${res.status} for ${name}`);
        return (await res.json()) as Packument;
      })();
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return p;
  }

  async #pick(name: string, range: string, cache: Map<string, Promise<Packument>>, full = false): Promise<VersionManifest> {
    const doc = await this.#packument(name, full, cache);
    const versions = Object.keys(doc.versions ?? {});
    const tagged = doc['dist-tags']?.[range];
    let version: string | null | undefined = tagged;
    if (!version) {
      if (!semver.validRange(range)) throw new InstallError(`${name}@${range}: unsupported version spec`);
      const latest = doc['dist-tags']?.latest;
      version = latest && semver.satisfies(latest, range) ? latest : semver.maxSatisfying(versions, range);
    }
    const manifest = version ? doc.versions[version] : undefined;
    if (!manifest) throw new InstallError(`no version of ${name} matches ${range}`);
    return manifest;
  }

  /** Latest published version (cached for 30 minutes; null when unknown or offline). */
  async latest(name: string, force = false): Promise<string | null> {
    const hit = this.#latest.get(name);
    if (hit && !force && Date.now() - hit.at < 30 * 60_000) return hit.version;
    let version: string | null = null;
    try {
      version = (await this.#packument(name))['dist-tags']?.latest ?? null;
    } catch {
      version = null;
    }
    this.#latest.set(name, { at: Date.now(), version });
    return version;
  }

  // ---------------------------------------------------------------- resolve

  /** Works out the whole tree without writing anything (the install preview). */
  async resolve(source: PackageSource): Promise<ResolvedPlugin & { _plan: Plan }> {
    const warnings: string[] = [];
    const cache = new Map<string, Promise<Packument>>();
    let rootManifest: VersionManifest;
    let rootData: Buffer | undefined;
    let spec: string;
    if ('tarball' in source) {
      rootData = source.tarball;
      const pkgJson = readTar(rootData).find((e) => e.type === 'file' && /^[^/]+\/package\.json$/.test(e.path));
      if (!pkgJson) throw new InstallError('the file is not an npm package (no package.json)');
      rootManifest = JSON.parse(pkgJson.data.toString('utf8')) as VersionManifest;
      if (!rootManifest.name || !NAME.test(rootManifest.name) || !semver.valid(rootManifest.version)) throw new InstallError('package.json needs a valid name and version');
      spec = source.filename ?? `${rootManifest.name}-${rootManifest.version}.tgz`;
    } else {
      const { name, range } = parseSpec(source.spec);
      rootManifest = await this.#pick(name, range, cache, true);
      spec = source.spec.trim();
    }

    const root: Node = { folder: rootManifest.name, manifest: rootManifest, path: '' };
    const placed = new Map<string, Node>();
    const sdkRanges = new Set<string>();
    const queue: Node[] = [root];
    const lookup = (from: string, folder: string): Node | undefined => {
      let cur = from;
      for (;;) {
        const hit = placed.get(`${cur ? `${cur}/` : ''}node_modules/${folder}`);
        if (hit) return hit;
        if (!cur) return undefined;
        const i = cur.lastIndexOf('/node_modules/');
        cur = i === -1 ? '' : cur.slice(0, i);
      }
    };

    while (queue.length) {
      const node = queue.shift()!;
      const m = node.manifest;
      const bundled = new Set(Array.isArray(m.bundleDependencies) ? m.bundleDependencies : Array.isArray(m.bundledDependencies) ? m.bundledDependencies : []);
      const deps: [string, string, boolean][] = [
        ...Object.entries(m.dependencies ?? {}).map(([n, r]) => [n, r, false] as [string, string, boolean]),
        ...Object.entries(m.optionalDependencies ?? {}).map(([n, r]) => [n, r, true] as [string, string, boolean]),
        ...Object.entries(m.peerDependencies ?? {})
          .filter(([n]) => !m.peerDependenciesMeta?.[n]?.optional || SDK.has(n))
          .map(([n, r]) => [n, r, false] as [string, string, boolean]),
      ];
      const seen = new Set<string>();
      for (const [folder, rawSpec, optional] of deps) {
        if (seen.has(folder) || bundled.has(folder)) continue;
        seen.add(folder);
        if (SDK.has(folder)) {
          if (folder === '@livynq/sdk') sdkRanges.add(rawSpec);
          continue;
        }
        let realName = folder;
        let range = rawSpec;
        if (rawSpec.startsWith('npm:')) ({ name: realName, range } = parseSpec(rawSpec.slice(4)));
        else if (/^(file|link|git|git\+|github|https?):|\//.test(rawSpec) || (/^[^@]+\/[^@]+/.test(rawSpec) && !semver.validRange(rawSpec))) {
          const msg = `${m.name} depends on ${folder} via "${rawSpec}", which only npm can install`;
          if (optional) { warnings.push(msg); continue; }
          throw new InstallError(msg);
        }
        const found = lookup(node.path, folder);
        if (found && found.manifest.name === realName && semver.satisfies(found.manifest.version, range === 'latest' ? '*' : range, { includePrerelease: true })) continue;
        let manifest: VersionManifest;
        try {
          manifest = await this.#pick(realName, range, cache);
          if (!platformOk(manifest.os, this.#o.platform) || !platformOk(manifest.cpu, this.#o.arch)) {
            if (optional) continue; // e.g. a native binary for another platform
            throw new InstallError(`${manifest.name}@${manifest.version} does not support ${this.#o.platform}/${this.#o.arch}`);
          }
        } catch (err) {
          if (optional) {
            warnings.push(`optional ${folder} skipped: ${(err as Error).message}`);
            continue;
          }
          throw err;
        }
        // Not visible from here: hoist to the top. Shadowed by another version: nest under the dependent.
        const path = found ? `${node.path ? `${node.path}/` : ''}node_modules/${folder}` : `node_modules/${folder}`;
        const child: Node = { folder, manifest, path };
        placed.set(path, child);
        queue.push(child);
        if (placed.size > MAX_PACKAGES) throw new InstallError(`${rootManifest.name} pulls in more than ${MAX_PACKAGES} packages`);
      }
    }

    const ranges = [...sdkRanges];
    const compatible = ranges.every((r) => semver.validRange(r) !== null && semver.satisfies(this.#o.hubVersion, r, { includePrerelease: true }));
    if (!ranges.length) warnings.push(`${rootManifest.name} does not depend on @livynq/sdk; it may not be a Livynq plugin`);
    else if (!compatible) warnings.push(`${rootManifest.name} was built for @livynq/sdk ${ranges.join(' / ')}; this hub provides ${this.#o.hubVersion}`);
    const nodes = [...placed.values()];
    const scripted = [root, ...nodes].filter((n) => scriptsInstall(n.manifest)).map((n) => n.manifest.name);
    if (scripted.length) warnings.push(`install scripts are not run (${scripted.slice(0, 5).join(', ')}${scripted.length > 5 ? ', …' : ''}); packages that need them to build native code will not work`);

    return {
      root: {
        name: rootManifest.name,
        version: rootManifest.version,
        ...(rootManifest.description ? { description: rootManifest.description } : {}),
        ...(authorOf(rootManifest.author) ? { author: authorOf(rootManifest.author) } : {}),
        ...(rootManifest.license ? { license: rootManifest.license } : {}),
        ...(rootManifest.homepage ? { homepage: rootManifest.homepage } : {}),
        hasInstallScript: scriptsInstall(rootManifest),
      },
      packages: nodes.map((n) => ({ name: n.manifest.name, version: n.manifest.version, path: n.path, hasInstallScript: scriptsInstall(n.manifest) })),
      sdk: { ranges, provided: this.#o.hubVersion, compatible },
      warnings,
      source: rootData ? 'file' : 'registry',
      spec,
      _plan: { root, nodes, rootData },
    };
  }

  // ---------------------------------------------------------------- install

  async #download(m: VersionManifest): Promise<Buffer> {
    const url = m.dist?.tarball;
    if (!url) throw new InstallError(`${m.name}@${m.version} has no tarball`);
    let res: Response;
    try {
      res = await this.#o.fetch(url, { signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new InstallError(`download of ${m.name}@${m.version} failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new InstallError(`download of ${m.name}@${m.version} failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_TARBALL) throw new InstallError(`${m.name}@${m.version} is too large`);
    if (!integrityOk(data, m.dist)) throw new InstallError(`${m.name}@${m.version}: the download does not match the registry's integrity hash`);
    return data;
  }

  /** Resolves (unless given a resolution), downloads, verifies and installs; replaces an existing copy atomically. */
  async install(source: PackageSource | (ResolvedPlugin & { _plan: Plan })): Promise<InstalledRecord> {
    const resolved = '_plan' in source ? source : await this.resolve(source);
    const { root, nodes, rootData } = resolved._plan;
    const staging = join(this.dir, '.staging', randomBytes(6).toString('hex'));
    mkdirSync(staging, { recursive: true });
    try {
      const jobs: { node: Node; data?: Buffer }[] = [{ node: root, ...(rootData ? { data: rootData } : {}) }, ...nodes.map((node) => ({ node }))];
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const job = jobs[next++]!;
          const data = job.data ?? (await this.#download(job.node.manifest));
          const dir = job.node.path ? join(staging, ...job.node.path.split('/')) : staging;
          mkdirSync(dir, { recursive: true });
          extractPackage(data, dir);
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
      this.#writeShims(staging);

      const target = this.packageDir(root.manifest.name);
      mkdirSync(dirname(target), { recursive: true });
      const trash = join(this.dir, '.trash', randomBytes(6).toString('hex'));
      if (existsSync(target)) {
        mkdirSync(dirname(trash), { recursive: true });
        renameSync(target, trash);
      }
      renameSync(staging, target);
      rmSync(trash, { recursive: true, force: true });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const record: InstalledRecord = {
      name: root.manifest.name,
      version: root.manifest.version,
      source: resolved.source,
      spec: resolved.spec,
      installedAt: Date.now(),
      packages: nodes.length + 1,
    };
    this.#saveInstalled({ ...this.installed(), [record.name]: record });
    return record;
  }

  #writeShims(pluginDir: string): void {
    for (const shim of sdkShims(this.#o.hubVersion)) {
      const dir = join(pluginDir, 'node_modules', ...shim.name.split('/'));
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const [file, content] of Object.entries(shim.files)) writeFileSync(join(dir, file), content);
    }
  }

  /** Rewrites the SDK shims of every installed plugin (a newer hub may export more). */
  refreshShims(): void {
    for (const name of Object.keys(this.installed())) {
      const dir = this.packageDir(name);
      if (existsSync(join(dir, 'package.json'))) this.#writeShims(dir);
    }
  }

  /** Removes the plugin's files; false when it was not installed here. */
  uninstall(name: string): boolean {
    const records = this.installed();
    const dir = this.packageDir(name);
    const existed = existsSync(dir);
    rmSync(dir, { recursive: true, force: true });
    if (name.startsWith('@')) {
      const scope = dirname(dir);
      try {
        if (!readdirSync(scope).length) rmdirSync(scope);
      } catch {
        // scope dir already gone
      }
    }
    const had = name in records;
    delete records[name];
    if (had) this.#saveInstalled(records);
    return existed || had;
  }
}

export interface Plan {
  root: Node;
  nodes: Node[];
  rootData?: Buffer;
}

/** The resolve result without internals, for API responses. */
export function publicResolution(r: ResolvedPlugin & { _plan?: Plan }): ResolvedPlugin {
  const { _plan, ...rest } = r;
  return rest;
}
