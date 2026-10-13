import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, Home, readBackupManifest, readTar, restoreBackup, writeAutomaticBackup, writeTar } from '@livynq/core';

test('tar round trip incl. long names', () => {
  const long = `${'deep/'.repeat(30)}file.json`;
  const entries = readTar(writeTar([{ path: 'a.txt', data: Buffer.from('hello') }, { path: long, data: Buffer.from('{}') }, { path: 'dir', type: 'dir' }]));
  assert.deepEqual(entries.map((e) => [e.path, e.type, e.data.toString()]), [['a.txt', 'file', 'hello'], [long, 'file', '{}'], ['dir', 'dir', '']]);
});

test('backup → restore keeps database, secrets and config; encrypted backups need the password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-bk-'));
  const target = mkdtempSync(join(tmpdir(), 'livynq-restore-'));
  try {
    const home = new Home({ dataDir: dir });
    home.registry.createRoom({ name: 'Office' });
    const { token } = home.tokens.create('cli', 'admin');
    mkdirSync(join(dir, 'secrets', 'hap'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'hap', 'bridge.json'), '{"username":"0E:AA"}');
    writeFileSync(join(dir, 'livynq.yaml'), 'server: { port: 9999 }\n');

    const plain = createBackup(home, { version: '0.1.0' });
    assert.equal(readBackupManifest(plain.data).files, 3);
    const secret = createBackup(home, { version: '0.1.0', password: 'correct horse' });
    assert.throws(() => readBackupManifest(secret.data), /encrypted/);
    assert.throws(() => readBackupManifest(secret.data, 'wrong password'), /Wrong password/);
    assert.equal(readBackupManifest(secret.data, 'correct horse').encrypted, true);

    const auto = writeAutomaticBackup(home, '0.1.0', 1);
    assert.ok(existsSync(auto));
    await home.stop();

    writeFileSync(join(target, 'old.txt'), 'previous data');
    const result = restoreBackup(secret.data, target, { password: 'correct horse' });
    assert.ok(result.previous && existsSync(join(result.previous, 'old.txt')), 'previous data kept aside');
    assert.equal(readFileSync(join(target, 'secrets', 'hap', 'bridge.json'), 'utf8'), '{"username":"0E:AA"}');
    assert.equal(statSync(join(target, 'secrets', 'hap', 'bridge.json')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(target, 'livynq.yaml'), 'utf8'), 'server: { port: 9999 }\n');

    const restored = new Home({ dataDir: target });
    assert.equal(restored.registry.findRoom('Office')?.name, 'Office');
    assert.equal(restored.tokens.verify(token)?.name, 'cli', 'tokens survive a restore');
    await restored.stop();
    rmSync(result.previous!, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
