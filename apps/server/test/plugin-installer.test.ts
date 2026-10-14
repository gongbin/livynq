import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import pino from 'pino';
import { Home, writeTar } from '@livynq/core';
import { createServer as createApi } from '../src/server.ts';
import { PluginInstaller, extractPackage } from '../src/plugins/installer.ts';
import { PluginManager } from '../src/plugins/manager.ts';

type Files = Record<string, string>;
interface Published {
  manifest: Record<string, unknown>;
  tarball: Buffer;
}

/** Minimal npm registry: packuments (full and abbreviated look the same here) and tarballs. */
class FakeRegistry {
  readonly packages = new Map<string, Map<string, Published>>();
  readonly tags = new Map<string, Record<string, string>>();
  readonly requests: string[] = [];
  #server: Server | undefined;
  url = '';

  publish(name: string, version: string, extra: Record<string, unknown> = {}, files: Files = {}, options: { badIntegrity?: boolean; rawTarball?: Buffer } = {}): void {
    const manifest = { name, version, ...extra };
    const tarball = options.rawTarball ?? gzipSync(writeTar([{ path: 'package/package.json', data: Buffer.from(JSON.stringify(manifest)) }, ...Object.entries(files).map(([p, c]) => ({ path: `package/${p}`, data: Buffer.from(c) }))]));
    const integrity = `sha512-${createHash('sha512').update(options.badIntegrity ? Buffer.from('tampered') : tarball).digest('base64')}`;
    const versions = this.packages.get(name) ?? new Map<string, Published>();
    versions.set(version, { manifest: { ...manifest, dist: { tarball: `${this.url}/-/${encodeURIComponent(name)}/${version}.tgz`, integrity } }, tarball });
    this.packages.set(name, versions);
    this.tags.set(name, { ...this.tags.get(name), latest: version });
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? '');
      this.requests.push(url);
      const tar = /^\/-\/(.+)\/([^/]+)\.tgz$/.exec(url);
      if (tar) {
        const p = this.packages.get(tar[1]!)?.get(tar[2]!);
        if (!p) return res.writeHead(404).end();
        return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(p.tarball);
      }
      const name = url.slice(1);
      const versions = this.packages.get(name);
      if (!versions) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, 'dist-tags': this.tags.get(name), versions: Object.fromEntries([...versions].map(([v, p]) => [v, p.manifest])) }));
    });
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.#server?.close();
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'livynq-installer-'));
}

test('resolves semver ranges, hoists, nests conflicts, skips foreign optional deps, never runs scripts', async () => {
  const reg = new FakeRegistry();
  await reg.start();
  const dir = tmp();
  try {
    reg.publish('c', '1.0.0', {}, { 'index.js': 'export default 1' });
    reg.publish('c', '1.5.0', {}, { 'index.js': 'export default 15' });
    reg.publish('c', '2.1.0', {}, { 'index.js': 'export default 21' });
    reg.publish('c', '3.0.0', {}, { 'index.js': 'export default 3' });
    const marker = join(dir, 'pwned');
    reg.publish('a', '1.0.0', { dependencies: { c: '^1.0.0' }, scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}', '')"` }, hasInstallScript: true });
    reg.publish('b', '1.2.0', { dependencies: { c: '^2.0.0' } });
    reg.publish('win-only', '1.0.0', { os: ['win32'] });
    reg.publish('livynq-plugin-acme', '1.0.0', { dependencies: { a: '^1.0.0', b: '~1.2.0', '@livynq/sdk': '^0.2.0' }, optionalDependencies: { 'win-only': '1.0.0' }, description: 'Acme lights', license: 'MIT', author: { name: 'Acme' } }, { 'index.js': 'export default {}' });

    const installer = new PluginInstaller({ dir, hubVersion: '0.2.0', registry: reg.url, platform: 'linux', arch: 'x64' });
    const plan = await installer.resolve({ spec: 'livynq-plugin-acme' });
    assert.deepEqual([plan.root.name, plan.root.version, plan.root.author, plan.root.license], ['livynq-plugin-acme', '1.0.0', 'Acme', 'MIT']);
    assert.deepEqual(
      plan.packages.map((p) => `${p.path}@${p.version}`).sort(),
      ['node_modules/a@1.0.0', 'node_modules/b/node_modules/c@2.1.0', 'node_modules/b@1.2.0', 'node_modules/c@1.5.0'],
      'c@1 is hoisted, b gets its own c@2; the win32-only optional dep is skipped',
    );
    assert.deepEqual(plan.sdk, { ranges: ['^0.2.0'], provided: '0.2.0', compatible: true });
    assert.ok(plan.warnings.some((w) => /install scripts are not run \(a\)/.test(w)));

    const record = await installer.install(plan);
    assert.equal(record.packages, 5);
    const root = installer.packageDir('livynq-plugin-acme');
    assert.equal(readFileSync(join(root, 'node_modules/c/index.js'), 'utf8'), 'export default 15');
    assert.equal(readFileSync(join(root, 'node_modules/b/node_modules/c/index.js'), 'utf8'), 'export default 21');
    assert.ok(!existsSync(join(root, 'node_modules/win-only')));
    assert.ok(!existsSync(marker), 'install scripts never run');
    assert.match(readFileSync(join(root, 'node_modules/@livynq/sdk/index.js'), 'utf8'), /export const \{ .*defineAdapter.* \} = m;/);
    assert.equal(installer.installed()['livynq-plugin-acme']?.version, '1.0.0');
    assert.ok(!reg.requests.some((r) => r.includes('@livynq/sdk')), 'the SDK comes from the hub, not the registry');

    assert.equal(installer.uninstall('livynq-plugin-acme'), true);
    assert.ok(!existsSync(root));
    assert.deepEqual(installer.installed(), {});
  } finally {
    reg.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integrity mismatches, links and paths outside the package are refused; nothing is left behind', async () => {
  const reg = new FakeRegistry();
  await reg.start();
  const dir = tmp();
  try {
    reg.publish('evil-dep', '1.0.0', {}, {}, { badIntegrity: true });
    reg.publish('livynq-plugin-bad', '1.0.0', { dependencies: { 'evil-dep': '1' } });
    const installer = new PluginInstaller({ dir, hubVersion: '0.2.0', registry: reg.url });
    await assert.rejects(installer.install({ spec: 'livynq-plugin-bad' }), /integrity/);
    assert.ok(!existsSync(installer.packageDir('livynq-plugin-bad')));
    assert.ok(!existsSync(join(dir, '.staging')) || !readdirSync(join(dir, '.staging')).length);

    const traversal = gzipSync(writeTar([{ path: 'package/package.json', data: Buffer.from('{"name":"x","version":"1.0.0"}') }, { path: 'package/../../escape.js', data: Buffer.from('x') }]));
    assert.throws(() => extractPackage(traversal, join(dir, 'x')), /outside the package/);
    assert.ok(!existsSync(join(dir, '..', 'escape.js')));
    const link = gzipSync(writeTar([{ path: 'package/package.json', data: Buffer.from('{"name":"y","version":"1.0.0"}') }, { path: 'package/passwd', type: 'symlink', linkTarget: '/etc/passwd' }]));
    assert.throws(() => extractPackage(link, join(dir, 'y')), /refusing the link/);

    await assert.rejects(installer.resolve({ spec: 'does-not-exist' }), /was not found/);
    await assert.rejects(installer.resolve({ spec: 'livynq-plugin-bad@^9' }), /no version/);
    await assert.rejects(installer.resolve({ spec: '../etc' }), /not an npm package name/);
  } finally {
    reg.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real plugin: one light whose name shows the installed version. */
function helloPlugin(version: string): Files {
  return {
    'index.js': `import { defineAdapter, DeviceTypes } from '@livynq/sdk';
export default defineAdapter({
  async setup(ctx) {
    const d = await ctx.devices.upsert({ id: 'hello:1', name: 'Hello ${version} ' + (ctx.config.suffix ?? ''), protocol: 'virtual', endpoints: [{ id: 1, deviceType: DeviceTypes.OnOffLight.id, capabilities: ['onOff'] }] });
    d.handle(1, 'onOff', { on: () => d.update(1, 'onOff', { onOff: true }), off: () => d.update(1, 'onOff', { onOff: false }), toggle: () => {} });
    d.setAvailability('online');
  },
});
`,
  };
}

test('API: preview, install, run, update check, upgrade, disable/enable, configure, uninstall — live', async () => {
  const reg = new FakeRegistry();
  await reg.start();
  const dir = tmp();
  const home = new Home({ dataDir: dir });
  try {
    const helloManifest = { type: 'module', exports: './index.js', dependencies: { '@livynq/sdk': '0.2.0' }, description: 'Says hello' };
    reg.publish('livynq-plugin-hello', '1.0.0', helloManifest, helloPlugin('1.0.0'));
    const plugins = new PluginManager(home, {
      installer: new PluginInstaller({ dir: join(dir, 'plugins'), hubVersion: '0.2.0', registry: reg.url }),
      official: [{ method: 'virtual', module: '@livynq/plugin-virtual', id: 'virtual', isolation: 'in-process' }],
      hubVersion: '0.2.0',
      resolveBuiltin: (s) => {
        throw new Error(`no builtin ${s}`);
      },
    });
    const app = await createApi(home, { logger: pino({ level: 'silent' }), webRoot: '/nonexistent', plugins });
    await home.start();
    const admin = home.tokens.create('admin', 'admin').token;
    const reader = home.tokens.create('reader', 'read').token;
    const req = (method: string, url: string, token: string, payload?: unknown) => app.inject({ method: method as 'GET', url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

    assert.equal((await req('POST', '/api/v1/plugins/resolve', reader, { spec: 'livynq-plugin-hello' })).statusCode, 403);
    const preview = (await req('POST', '/api/v1/plugins/resolve', admin, { spec: 'livynq-plugin-hello' })).json();
    assert.deepEqual([preview.id, preview.root.version, preview.root.description, preview.packages.length, preview.sdk.compatible, preview.installedVersion], ['hello', '1.0.0', 'Says hello', 0, true, null]);
    assert.ok(!existsSync(join(dir, 'plugins/node_modules/livynq-plugin-hello')), 'preview writes nothing');

    const installed = await req('POST', '/api/v1/plugins/install', admin, { spec: 'livynq-plugin-hello' });
    assert.equal(installed.statusCode, 201, installed.body);
    assert.deepEqual([installed.json().status, installed.json().version, installed.json().source], ['running', '1.0.0', 'installed']);
    assert.match(home.registry.requireDevice('hello:1').name, /^Hello 1\.0\.0/);

    reg.publish('livynq-plugin-hello', '1.1.0', helloManifest, helloPlugin('1.1.0'));
    const rows = (await req('GET', '/api/v1/plugins?all=1&updates=1&force=1', admin)).json() as { id: string; latest: string; updateAvailable: boolean; official: boolean; status: string }[];
    const hello = rows.find((r) => r.id === 'hello')!;
    assert.deepEqual([hello.latest, hello.updateAvailable], ['1.1.0', true]);
    assert.deepEqual(rows.find((r) => r.id === 'virtual'), { ...rows.find((r) => r.id === 'virtual'), official: true, status: 'off' });

    const upRes = await req('POST', '/api/v1/plugins/hello/upgrade', admin);
    assert.equal(upRes.statusCode, 200, upRes.body);
    const upgraded = upRes.json();
    assert.deepEqual([upgraded.upgraded, upgraded.from, upgraded.version, upgraded.status], [true, '1.0.0', '1.1.0', 'running']);
    assert.match(home.registry.requireDevice('hello:1').name, /^Hello 1\.1\.0/);
    assert.equal((await req('POST', '/api/v1/plugins/hello/upgrade', admin)).json().upgraded, false);

    assert.equal((await req('POST', '/api/v1/plugins/hello/disable', admin)).json().status, 'off');
    assert.equal(home.registry.requireDevice('hello:1').availability, 'offline');
    assert.equal((await req('POST', '/api/v1/plugins/hello/enable', admin)).json().status, 'running');
    const configured = (await req('PUT', '/api/v1/plugins/hello/config', admin, { config: { suffix: 'kitchen' } })).json();
    assert.deepEqual(configured.config, { suffix: 'kitchen' });
    assert.match(home.registry.requireDevice('hello:1').name, /kitchen$/);
    assert.equal((await req('PUT', '/api/v1/plugins/hello/config', admin, { config: [1] })).statusCode, 400);

    // A .tgz upload: preview keeps the file for the install step.
    const tgz = reg.packages.get('livynq-plugin-hello')!.get('1.0.0')!.tarball;
    const up = await app.inject({ method: 'POST', url: '/api/v1/plugins/resolve?filename=hello.tgz', payload: tgz, headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/gzip' } });
    assert.equal(up.statusCode, 200, up.body);
    assert.deepEqual([up.json().source, up.json().installedVersion, typeof up.json().uploadId], ['file', '1.1.0', 'string']);
    const fromFile = (await req('POST', '/api/v1/plugins/install', admin, { uploadId: up.json().uploadId })).json();
    assert.deepEqual([fromFile.version, fromFile.canUpgrade, fromFile.status], ['1.0.0', false, 'running']);
    assert.equal((await req('POST', '/api/v1/plugins/hello/upgrade', admin)).statusCode, 400, 'file installs are upgraded with a new file');

    assert.equal((await req('DELETE', '/api/v1/plugins/hello?uninstall=true', admin)).statusCode, 204);
    assert.ok(!existsSync(join(dir, 'plugins/node_modules/livynq-plugin-hello')));
    assert.ok(!(await req('GET', '/api/v1/plugins?all=1', admin)).json().some((r: { id: string }) => r.id === 'hello'));
    assert.ok(!home.adapters().includes('hello'));
    await app.close();
  } finally {
    await home.stop();
    reg.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file: dependencies shipped inside a package are copied from its tarball; escaping ones are refused', async () => {
  const reg = new FakeRegistry();
  await reg.start();
  const dir = tmp();
  try {
    reg.publish('dep-x', '1.0.0', {}, { 'index.js': 'module.exports = 1' });
    reg.publish('with-local', '1.0.0', { dependencies: { local: 'file:./lib/local', '@livynq/sdk': '^0.2.0' } }, {
      'index.js': 'export default 1',
      'lib/local/package.json': JSON.stringify({ name: 'local', version: '0.6.7', main: 'i.js', dependencies: { 'dep-x': '^1.0.0' } }),
      'lib/local/i.js': 'module.exports = "local"',
    });
    reg.publish('escapes', '1.0.0', { dependencies: { x: 'file:../../../etc' } });
    const installer = new PluginInstaller({ dir, hubVersion: '0.2.0', registry: reg.url });
    const plan = await installer.resolve({ spec: 'with-local' });
    assert.deepEqual(plan.packages.map((p) => [p.name, p.version, p.path]).sort(), [['dep-x', '1.0.0', 'node_modules/dep-x'], ['local', '0.6.7', 'node_modules/local']]);
    await installer.install(plan);
    const root = installer.packageDir('with-local');
    assert.equal(readFileSync(join(root, 'node_modules', 'local', 'i.js'), 'utf8'), 'module.exports = "local"');
    assert.ok(existsSync(join(root, 'node_modules', 'dep-x', 'index.js')));
    assert.equal(reg.requests.filter((r) => r.endsWith('with-local/1.0.0.tgz')).length, 1, 'the tarball is downloaded once');
    await assert.rejects(installer.resolve({ spec: 'escapes' }), /only npm can install/);
  } finally {
    reg.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
