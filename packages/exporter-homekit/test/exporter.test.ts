import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePortRange, run } from './run-helper.ts';
test('bridge identity and accessory ids are stable across restarts and removals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-hap-'));
  const port = await freePortRange(1);
  try {
    const first = await run(dir, port);
    assert.equal(Object.keys(first.ids).length, 11);
    assert.match(first.bridge.pincode, /^\d{3}-\d{2}-\d{3}$/);
    assert.match(first.bridge.setupURI, /^X-HM:\/\//);

    // Hide one device from HomeKit and restart: the others keep their ids.
    const second = await run(dir, port, (home) => home.registry.updateDevice('demo:coffee-plug', { exposure: { homekit: false } }));
    assert.equal(second.ids['demo:coffee-plug'], undefined);
    const third = await run(dir, port, (home) => home.registry.updateDevice('demo:coffee-plug', { exposure: { homekit: true } }));
    assert.deepEqual(third.ids, first.ids, 'every device, including the re-exposed one, keeps its AID');
    assert.equal(third.bridge.setupURI, first.bridge.setupURI);
    assert.equal(third.bridge.pincode, first.bridge.pincode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
