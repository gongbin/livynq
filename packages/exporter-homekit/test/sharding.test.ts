// Separate file: HAP-NodeJS storage is one directory per process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run-helper.ts';

test('more accessories than fit on one bridge: extra bridges with persistent assignment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-hap-shard-'));
  const port = 53000 + Math.floor(Math.random() * 1000);
  try {
    const first = await run(dir, port, undefined, 2);
    // 11 demo accessories, 2 per bridge → 6 bridges on consecutive ports
    assert.deepEqual(first.bridges.map((b) => [b.id, b.port, b.accessoryCount]), [
      ['main', port, 2], ['bridge-2', port + 1, 2], ['bridge-3', port + 2, 2], ['bridge-4', port + 3, 2], ['bridge-5', port + 4, 2], ['bridge-6', port + 5, 1],
    ]);
    assert.equal(new Set(first.bridges.map((b) => b.setupURI)).size, 6, 'each bridge pairs separately');

    // Hide a device on the first bridge: a newly exposed device must not take its seat permanently,
    // and when it comes back it returns to its own bridge with its own AID.
    const hidden = Object.keys(first.assignments).find((k) => first.assignments[k] === 0)!;
    const second = await run(dir, port, (home) => home.registry.updateDevice(hidden, { exposure: { homekit: false } }), 2);
    assert.equal(second.ids[hidden], undefined);
    const third = await run(dir, port, (home) => home.registry.updateDevice(hidden, { exposure: { homekit: true } }), 2);
    assert.deepEqual(third.assignments, first.assignments);
    assert.deepEqual(third.ids, first.ids);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
