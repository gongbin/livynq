/**
 * Compiles the packages published to npm (model, sdk, official plugins) to JS + .d.ts in
 * <pkg>/dist. In the workspace everything runs from .ts sources; Node does not strip types inside
 * node_modules, so installed copies need JS. `publishConfig.exports` points npm at dist.
 *
 *   node scripts/build-packages.ts            # build all
 *   node scripts/build-packages.ts --check    # also verify every package's manifest
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

/** In dependency order. */
export const PUBLISHED = ['packages/model', 'packages/sdk', ...readdirSync(join(root, 'plugins')).sort().map((d) => `plugins/${d}`)];

const built = new Map<string, string>(); // package name -> dist/index.d.ts

for (const dir of PUBLISHED) {
  const abs = join(root, dir);
  const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8')) as {
    name: string;
    private?: boolean;
    files?: string[];
    publishConfig?: { exports?: Record<string, { types: string; default: string }> };
  };
  if (pkg.private) throw new Error(`${pkg.name} is private but listed for publishing`);
  const exp = pkg.publishConfig?.exports?.['.'];
  if (exp?.default !== './dist/index.js' || exp.types !== './dist/index.d.ts' || !pkg.files?.includes('dist')) {
    throw new Error(`${pkg.name}: package.json needs files: ["dist"] and publishConfig.exports "." → ./dist/index.{js,d.ts}`);
  }
  rmSync(join(abs, 'dist'), { recursive: true, force: true });
  // Sibling packages resolve to their already built declarations, not their sources.
  const paths = Object.fromEntries([...built].map(([name, dts]) => [name, [relative(abs, dts)]]));
  const config = join(abs, 'tsconfig.build.json');
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: relative(abs, join(root, 'tsconfig.base.json')),
        compilerOptions: { noEmit: false, outDir: 'dist', rootDir: 'src', declaration: true, rewriteRelativeImportExtensions: true, sourceMap: false, paths },
        include: ['src'],
      },
      null,
      2,
    ),
  );
  try {
    execFileSync(process.execPath, [tsc, '-p', config], { cwd: abs, stdio: 'inherit' });
  } finally {
    rmSync(config, { force: true });
  }
  built.set(pkg.name, join(abs, 'dist', 'index.d.ts'));
  console.log(`built ${pkg.name}`);
}
