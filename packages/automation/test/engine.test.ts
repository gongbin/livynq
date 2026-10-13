import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DemoAdapter, Home, LivynqError } from '@livynq/core';
import { AutomationEngine } from '@livynq/automation';

const motion = (home: Home, occupied: boolean) => home.registry.updateState('demo:hallway-motion', 1, 'occupancySensing', { occupied }, 'test');
const lampOn = (home: Home) => home.registry.getAttribute('demo:bedroom-lamp', 1, 'onOff', 'onOff');

async function setup(dataDir = ':memory:') {
  const home = new Home({ dataDir });
  const engine = new AutomationEngine({ location: { latitude: 31.23, longitude: 121.47 } });
  home.useAdapter(new DemoAdapter({ simulateSensors: false })).useExtension(engine);
  await home.start();
  return { home, engine };
}

async function until(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(10);
  }
}

test('state trigger → conditions → HA service actions, with a trace', async () => {
  const { home, engine } = await setup();
  engine.save(
    {
      alias: 'Motion lights the bedroom',
      triggers: [{ trigger: 'state', entity_id: 'binary_sensor.hallway_motion', to: 'on', id: 'motion' }],
      conditions: [{ condition: 'state', entity_id: 'binary_sensor.front_door', state: 'off' }],
      actions: [
        { action: 'light.turn_on', target: { entity_id: 'light.bedroom_lamp' }, data: { brightness_pct: 50 } },
        { choose: [{ conditions: [{ condition: 'trigger', id: 'motion' }], sequence: [{ action: 'switch.turn_on', target: { area_id: 'Kitchen' } }] }] },
      ],
    },
    'test',
  );
  motion(home, true);
  await until(() => engine.traces('motion_lights_the_bedroom')[0]?.state === 'finished');
  assert.equal(lampOn(home), true);
  assert.equal(home.registry.getAttribute('demo:bedroom-lamp', 1, 'levelControl', 'currentLevel'), 128);
  assert.equal(home.registry.getAttribute('demo:coffee-plug', 1, 'onOff', 'onOff'), true);
  const trace = engine.traces('motion_lights_the_bedroom')[0]!;
  assert.equal(trace.trigger.description, 'state of binary_sensor.hallway_motion');
  assert.deepEqual(trace.conditions.map((c) => [c.path, c.result]), [['conditions/0', true], ['actions/1/choose/0/conditions/0', true]]);
  assert.deepEqual(trace.steps.map((s) => s.path), ['actions/0', 'actions/1', 'actions/1/choose/0/sequence/0']);
  assert.equal(home.recentCommands(1)[0]?.source, 'automation:motion_lights_the_bedroom');

  // Condition failure: the front door opens (contact closed=false → binary_sensor "on")
  home.registry.updateState('demo:front-door', 1, 'booleanState', { stateValue: false }, 'test');
  motion(home, false);
  motion(home, true);
  await until(() => engine.traces('motion_lights_the_bedroom').length === 2);
  assert.equal(engine.traces('motion_lights_the_bedroom')[0]!.stopReason, 'conditions not met');
  assert.equal(engine.traces('motion_lights_the_bedroom')[0]!.state, 'stopped');
  await home.stop();
});

test('`for` durations, wait_for_trigger and restart mode', async () => {
  const { home, engine } = await setup();
  engine.save(
    {
      id: 'auto_off',
      alias: 'Auto off',
      mode: 'restart',
      triggers: [{ trigger: 'state', entity_id: 'binary_sensor.hallway_motion', to: 'on' }],
      actions: [
        { action: 'light.turn_on', target: { entity_id: 'light.bedroom_lamp' } },
        { wait_for_trigger: [{ trigger: 'state', entity_id: 'binary_sensor.hallway_motion', to: 'off', for: 0.1 }], timeout: 5 },
        { action: 'light.turn_off', target: { entity_id: 'light.bedroom_lamp' } },
      ],
    },
    'test',
  );
  motion(home, true);
  await until(() => lampOn(home) === true);
  motion(home, false);
  await sleep(40);
  motion(home, true); // back before `for` elapsed: restart mode aborts the first run
  await sleep(150);
  assert.equal(lampOn(home), true, 'still on: motion returned');
  motion(home, false);
  await until(() => lampOn(home) === false);
  const states = engine.traces('auto_off').map((t) => t.state);
  assert.deepEqual(states.sort(), ['aborted', 'finished']);
  await home.stop();
});

test('modes: single ignores, queued queues; repeat/if/stop; errors are traced', async () => {
  const { home, engine } = await setup();
  engine.save({ id: 'slow', alias: 'slow', mode: 'single', triggers: [{ trigger: 'homeassistant', event: 'start' }], actions: [{ delay: 0.15 }] }, 'test');
  const a = engine.trigger('slow')!;
  assert.equal(engine.trigger('slow'), undefined, 'single mode ignores a second trigger');
  await engine.waitForRun('slow', a);

  engine.save({ id: 'q', alias: 'q', mode: 'queued', triggers: [{ trigger: 'homeassistant', event: 'start' }], actions: [{ delay: 0.05 }] }, 'test');
  engine.trigger('q');
  engine.trigger('q');
  engine.trigger('q');
  await until(() => engine.traces('q').length === 3 && engine.traces('q').every((t) => t.state === 'finished'), 3000);

  engine.save(
    {
      id: 'flow',
      alias: 'flow',
      triggers: [{ trigger: 'homeassistant', event: 'start' }],
      actions: [
        { repeat: { count: 3, sequence: [{ action: 'light.toggle', target: { entity_id: 'light.bedroom_lamp' } }] } },
        { if: [{ condition: 'state', entity_id: 'light.bedroom_lamp', state: 'on' }], then: [{ stop: 'lamp is on' }], else: [{ stop: 'lamp is off', error: true }] },
      ],
    },
    'test',
  );
  const run = await engine.waitForRun('flow', engine.trigger('flow')!);
  assert.equal(run.state, 'stopped');
  assert.equal(run.stopReason, 'lamp is on');
  assert.equal(run.steps.filter((s) => s.path === 'actions/0/repeat/sequence/0').length, 3);

  engine.save({ id: 'bad', alias: 'bad', triggers: [{ trigger: 'homeassistant', event: 'start' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'sensor.bedroom_climate_temperature' } }] }, 'test');
  const failed = await engine.waitForRun('bad', engine.trigger('bad')!);
  assert.equal(failed.state, 'error');
  assert.match(failed.error!, /No light entities/);
  await home.stop();
});

test('validation, versions, enable/disable, automation.* actions and webhooks', async () => {
  const { home, engine } = await setup();
  assert.throws(
    () => engine.save({ alias: 'x', triggers: [{ trigger: 'time', at: '07:00' }], actions: [{ action: 'notify.mobile', data: { message: 'hi' } }] }, 'test'),
    (e: LivynqError) => e.code === 'INVALID_PARAMS' && /notify.mobile" is not supported yet/.test(e.message),
  );
  const v = engine.validate({ alias: 'x', triggers: [{ trigger: 'nope' }], actions: [{ action: 'light.blink' }, { action: 'light.turn_on', target: { entity_id: 'light.ghost' } }] });
  assert.deepEqual(v.errors.slice(-1), ['actions[0].action: "light.blink" is not supported yet'], 'reported together with schema errors');
  assert.deepEqual(v.warnings, ['unknown entity light.ghost']);

  const hook = { id: 'hook', alias: 'Hook', triggers: [{ trigger: 'webhook', webhook_id: 'secret-hook-123' }], actions: [{ action: 'switch.toggle', target: { entity_id: 'switch.coffee_machine' } }] };
  engine.save(hook, 'test');
  engine.save({ ...hook, description: 'v2' }, 'test');
  assert.deepEqual(engine.versions('hook').map((v) => v.version), [2, 1]);
  assert.throws(() => engine.save(hook, 'test', { onlyCreate: true }), (e: LivynqError) => e.code === 'CONFLICT');

  assert.equal(engine.handleWebhook('secret-hook-123', { method: 'GET', local: true, query: {} }), true);
  assert.equal(engine.handleWebhook('secret-hook-123', { method: 'POST', local: false, query: {} }), true);
  await sleep(50);
  assert.equal(engine.traces('hook').length, 0, 'wrong method and non-local requests are ignored');
  engine.handleWebhook('secret-hook-123', { method: 'POST', local: true, query: {} });
  await until(() => engine.traces('hook')[0]?.state === 'finished');

  engine.save({ id: 'off', alias: 'off', triggers: [{ trigger: 'homeassistant', event: 'start' }], actions: [{ action: 'automation.turn_off', target: { entity_id: 'automation.hook' } }] }, 'test');
  await engine.waitForRun('off', engine.trigger('off')!);
  assert.equal(engine.get('hook').enabled, false);
  engine.handleWebhook('secret-hook-123', { method: 'POST', local: true, query: {} });
  await sleep(50);
  assert.equal(engine.traces('hook').length, 1, 'disabled automations do not fire');
  await home.stop();
});

test('automations, traces and enabled state persist across restarts; start trigger fires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'livynq-auto-'));
  try {
    let { home, engine } = await setup(dir);
    engine.save({ id: 'boot', alias: 'On boot', triggers: [{ trigger: 'homeassistant', event: 'start' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.bedroom_lamp' } }] }, 'test');
    engine.save({ id: 'disabled', alias: 'Disabled', triggers: [{ trigger: 'homeassistant', event: 'start' }], actions: [{ delay: 0 }] }, 'test', { enabled: false });
    await home.stop();

    ({ home, engine } = await setup(dir));
    await until(() => engine.traces('boot')[0]?.state === 'finished');
    assert.equal(lampOn(home), true);
    assert.equal(engine.get('disabled').enabled, false);
    assert.equal(engine.traces('disabled').length, 0);
    assert.ok(engine.get('boot').lastTriggered);
    await home.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

