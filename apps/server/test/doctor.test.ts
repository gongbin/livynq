import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { formatChecks, runDoctor } from '../src/cli/doctor.ts';

test('doctor: permissions, ports, network, serial sticks, running hub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-doctor-'));
  try {
    mkdirSync(join(dir, 'secrets'), { mode: 0o700 });
    writeFileSync(join(dir, 'secrets', 'cli.token'), 'x', { mode: 0o644 });
    chmodSync(join(dir, 'secrets', 'cli.token'), 0o644);
    writeFileSync(join(dir, 'livynq.yaml'), 'plugins:\n  - module: "@livynq/plugin-zwave"\n    id: zwave\n    config:\n      port: /dev/does-not-exist\n');
    const config = loadConfig({ dataDir: dir });
    const lan = () => ({ en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }] }) as never;

    const stopped = await runDoctor(config, { portFree: async (p) => p !== 51826, interfaces: lan });
    const by = (name: string) => stopped.find((c) => c.name === name);
    assert.equal(by('secrets')?.status, 'warn');
    assert.equal(by('port 8581')?.status, 'ok');
    assert.equal(by('port 51826')?.status, 'fail');
    assert.equal(by('serial zwave')?.status, 'fail');
    assert.equal(by('network')?.status, 'ok');
    assert.equal(by('backups')?.status, 'warn');
    assert.match(formatChecks(stopped), /2 problem\(s\)/);

    const noLan = await runDoctor(config, { portFree: async () => true, interfaces: () => ({}) });
    assert.equal(noLan.find((c) => c.name === 'network')?.status, 'fail');

    const hub = {
      get: async <T>(path: string): Promise<T> =>
        ({
          '/api/v1/system/info': { version: '9.9.9', adapters: [] },
          '/api/v1/plugins': [{ id: 'zigbee', status: 'crashed', lastError: 'port busy' }, { id: 'virtual', status: 'running' }],
          '/api/v1/devices': [{ name: 'Lamp', availability: 'offline' }, { name: 'Plug', availability: 'online' }],
        })[path] as T,
    };
    const running = await runDoctor(config, { hub, interfaces: lan, portFree: async () => assert.fail('ports are not probed while the hub runs') });
    assert.equal(running.find((c) => c.name === 'plugin zigbee')?.status, 'fail');
    assert.match(running.find((c) => c.name === 'devices')!.message, /1 of 2 offline: Lamp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
