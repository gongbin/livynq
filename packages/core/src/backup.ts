import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { LivynqError } from './errors.ts';
import type { Home } from './home.ts';
import { readTar, writeTar } from './tar.ts';

/**
 * A Livynq backup is a tar.gz with a consistent database snapshot plus everything needed
 * to come back without re-pairing: secrets/ (HomeKit identity & pairings, Zigbee/Z-Wave keys),
 * livynq.yaml and plugin data. Optionally encrypted with a password (scrypt + AES-256-GCM).
 */
export interface BackupManifest {
  format: 1;
  livynqVersion: string;
  createdAt: number;
  hostname: string;
  encrypted: boolean;
  files: number;
}

const MAGIC = Buffer.from('LVQBAK1\0');
const INCLUDED = ['secrets', 'plugin-data', 'livynq.yaml'];

function walk(root: string, dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  if (statSync(dir).isFile()) return void out.push(relative(root, dir));
  for (const name of readdirSync(dir)) walk(root, join(dir, name), out);
}

export function createBackup(home: Home, options: { version: string; password?: string }): { data: Buffer; manifest: BackupManifest } {
  if (home.dataDir === ':memory:') throw new LivynqError('NOT_SUPPORTED', 'In-memory homes cannot be backed up');
  const snapshot = join(tmpdir(), `livynq-snapshot-${randomBytes(6).toString('hex')}.db`);
  try {
    // VACUUM INTO gives a consistent, compact copy while the hub keeps running.
    home.storage.db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    const files: string[] = [];
    for (const entry of INCLUDED) walk(home.dataDir, join(home.dataDir, entry), files);
    const manifest: BackupManifest = {
      format: 1,
      livynqVersion: options.version,
      createdAt: Date.now(),
      hostname: hostname(),
      encrypted: Boolean(options.password),
      files: files.length + 1,
    };
    const tar = writeTar([
      { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { path: 'livynq.db', data: readFileSync(snapshot) },
      ...files.map((f) => ({ path: f.split(sep).join('/'), data: readFileSync(join(home.dataDir, f)), mode: statSync(join(home.dataDir, f)).mode & 0o777 })),
    ]);
    const gz = gzipSync(tar);
    return { data: options.password ? encrypt(gz, options.password) : gz, manifest };
  } finally {
    rmSync(snapshot, { force: true });
  }
}

function encrypt(data: Buffer, password: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(data: Buffer, password: string | undefined): Buffer {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) return data;
  if (!password) throw new LivynqError('UNAUTHORIZED', 'This backup is encrypted', 'Pass --password');
  const salt = data.subarray(8, 24);
  const iv = data.subarray(24, 36);
  const tag = data.subarray(36, 52);
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(52)), decipher.final()]);
  } catch {
    throw new LivynqError('UNAUTHORIZED', 'Wrong password or corrupted backup');
  }
}

export function readBackupManifest(data: Buffer, password?: string): BackupManifest {
  const entries = readTar(gunzipSync(decrypt(data, password)));
  const manifest = entries.find((e) => e.path === 'manifest.json');
  if (!manifest) throw new LivynqError('INVALID_PARAMS', 'Not a Livynq backup (no manifest.json)');
  return JSON.parse(manifest.data.toString('utf8')) as BackupManifest;
}

/**
 * Restores into `dataDir` (the hub must be stopped). The current directory is kept as
 * `<dataDir>.before-restore-<timestamp>` so a restore is itself reversible.
 */
export function restoreBackup(data: Buffer, dataDir: string, options: { password?: string } = {}): { manifest: BackupManifest; previous: string | null } {
  const entries = readTar(gunzipSync(decrypt(data, options.password)));
  const manifestEntry = entries.find((e) => e.path === 'manifest.json');
  if (!manifestEntry || !entries.some((e) => e.path === 'livynq.db')) throw new LivynqError('INVALID_PARAMS', 'Not a Livynq backup');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as BackupManifest;
  if (manifest.format !== 1) throw new LivynqError('NOT_SUPPORTED', `Unsupported backup format ${manifest.format}`);

  for (const e of entries) {
    if (e.path.startsWith('/') || e.path.split('/').includes('..')) throw new LivynqError('INVALID_PARAMS', `Unsafe path in backup: ${e.path}`);
  }
  let previous: string | null = null;
  if (existsSync(dataDir) && readdirSync(dataDir).length) {
    previous = `${dataDir}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(dataDir, previous);
  }
  mkdirSync(dataDir, { recursive: true });
  for (const e of entries) {
    if (e.type !== 'file' || e.path === 'manifest.json') continue;
    const target = join(dataDir, e.path);
    mkdirSync(dirname(target), { recursive: true, mode: e.path.startsWith('secrets/') ? 0o700 : 0o755 });
    writeFileSync(target, e.data, { mode: e.mode || 0o644 });
    if (e.path.startsWith('secrets/')) chmodSync(target, 0o600);
  }
  if (existsSync(join(dataDir, 'secrets'))) chmodSync(join(dataDir, 'secrets'), 0o700);
  return { manifest, previous };
}

/** Writes `backups/auto-YYYY-MM-DD.tar.gz` and keeps the newest `keep` automatic backups. */
export function writeAutomaticBackup(home: Home, version: string, keep = 7): string {
  const dir = join(home.dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `auto-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  writeFileSync(file, createBackup(home, { version }).data, { mode: 0o600 });
  const autos = readdirSync(dir).filter((f) => /^auto-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort();
  for (const old of autos.slice(0, Math.max(0, autos.length - keep))) rmSync(join(dir, old), { force: true });
  return file;
}
