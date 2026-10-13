/**
 * Builds the single-file executable for the current platform:
 *   dist/livynq-<os>-<arch>   (Node runtime + hub + web UI, no other files needed)
 *
 * Usage: node scripts/build-sea.ts [--skip-web]
 * Cross-platform binaries are produced by running this on each target (CI matrix).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const work = join(out, 'sea-work');
const version = (JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8')) as { version: string }).version;
const platform = `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
const binary = join(out, `livynq-${platform}${process.platform === 'win32' ? '.exe' : ''}`);
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

if (!process.argv.includes('--skip-web')) run('pnpm', ['--filter', '@livynq/web', 'build']);

// 1. Bundle the hub (TypeScript workspace + npm deps) into one CommonJS script.
const result = await build({
  entryPoints: [join(root, 'apps/server/src/sea-entry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: join(work, 'livynq.cjs'),
  define: { __LIVYNQ_VERSION__: JSON.stringify(version) },
  // Heavy / native plugin deps are not bundled; those plugins load from disk.
  external: ['zigbee-herdsman', 'zigbee-herdsman-converters', '@serialport/*', 'serialport', '@2colors/esphome-native-api'],
  logLevel: 'warning',
  // import.meta only appears on guarded development code paths (sources on disk), never taken in the SEA.
  logOverride: { 'empty-import-meta': 'silent' },
  legalComments: 'none',
  minifySyntax: true,
  metafile: true,
});
const bundleSize = statSync(join(work, 'livynq.cjs')).size;
console.log(`bundle: ${(bundleSize / 1024 / 1024).toFixed(1)} MB from ${Object.keys(result.metafile.inputs).length} files`);

// 2. Web UI as SEA assets.
const webDist = join(root, 'apps/web/dist');
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(webDist, p).split(sep).join('/'));
  }
};
walk(webDist);
writeFileSync(join(work, 'web-manifest.json'), JSON.stringify(files));
const assets: Record<string, string> = { 'web-manifest.json': join(work, 'web-manifest.json') };
for (const f of files) assets[`web/${f}`] = join(webDist, f);

// 3. SEA blob, injected into a copy of this Node binary.
writeFileSync(
  join(work, 'sea-config.json'),
  JSON.stringify({ main: join(work, 'livynq.cjs'), output: join(work, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2),
);
run(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')]);
copyFileSync(process.execPath, binary);
chmodSync(binary, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', binary]);
const postject = [binary, 'NODE_SEA_BLOB', join(work, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
run('pnpm', ['exec', 'postject', ...postject]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', binary]);
rmSync(work, { recursive: true, force: true });
console.log(`built ${relative(root, binary)} (${(statSync(binary).size / 1024 / 1024).toFixed(0)} MB, Livynq ${version}, Node ${process.version})`);
