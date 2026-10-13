import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPatternMatch, nextTimeOfDay, normalizeAutomation, parseDuration } from '@livynq/automation';

test('durations in all HA spellings', () => {
  assert.equal(parseDuration(90), 90_000);
  assert.equal(parseDuration('00:01:30'), 90_000);
  assert.equal(parseDuration('01:30'), 5_400_000, 'HH:MM');
  assert.equal(parseDuration({ minutes: 2, seconds: 5 }), 125_000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('soon'), undefined);
});

test('accepts legacy HA syntax (platform/service/singular keys) and scalar-or-list fields', () => {
  const { automation, errors } = normalizeAutomation({
    alias: 'Hallway night light',
    trigger: { platform: 'state', entity_id: 'binary_sensor.hallway_motion', to: 'on' },
    condition: [{ condition: 'sun', after: 'sunset', before: 'sunrise' }],
    action: [{ service: 'light.turn_on', entity_id: 'light.hallway', data: { brightness_pct: 30 } }, { delay: '00:02:00' }],
  });
  assert.deepEqual(errors, []);
  assert.equal(automation!.id, 'hallway_night_light');
  assert.deepEqual(automation!.triggers[0], { trigger: 'state', entity_id: ['binary_sensor.hallway_motion'], attribute: undefined, from: undefined, to: ['on'], not_from: undefined, not_to: undefined, for: undefined });
  assert.deepEqual(automation!.actions[0], { type: 'service', action: 'light.turn_on', target: { entity_id: 'light.hallway' }, data: { brightness_pct: 30 } });
  assert.deepEqual(automation!.actions[1], { type: 'delay', delay: 120_000 });
});

test('reports precise errors for unsupported or invalid parts', () => {
  const { errors } = normalizeAutomation({
    alias: 'Broken',
    triggers: [{ trigger: 'state' }, { trigger: 'zone', entity_id: 'person.x' }, { trigger: 'time', at: 'input_datetime.alarm' }],
    conditions: ['{{ is_state("x", "on") }}'],
    actions: [{ action: 'light.turn_on', data: { brightness: '{{ 1 }}' } }, { delay: 'later' }, { bogus: 1 }],
  });
  assert.deepEqual(errors, [
    'triggers[0].entity_id: is required',
    'triggers[1].trigger: unsupported trigger "zone" (supported: state, numeric_state, time, time_pattern, sun, homeassistant, webhook)',
    'triggers[2].at[0]: must be "HH:MM" or "HH:MM:SS" (entity-based times are not supported yet)',
    'conditions[0]: template conditions are not supported yet',
    'actions[0].data: templates are not supported yet',
    'actions[1].delay: must be a duration like 90, "00:01:30" or {minutes: 1}',
    'actions[2]: unknown action (supported: action/service, delay, wait_for_trigger, condition, choose, if, repeat, parallel, sequence, stop)',
  ]);
  assert.match(normalizeAutomation({ triggers: [], actions: [] }).errors.join(), /alias: is required/);
});

test('disabled items are skipped; shorthand and/or/not conditions', () => {
  const { automation, errors } = normalizeAutomation({
    id: 'x',
    alias: 'x',
    triggers: [{ trigger: 'homeassistant', event: 'start' }, { trigger: 'bogus', enabled: false }],
    conditions: [{ or: [{ condition: 'trigger', id: 'a' }, { not: [{ condition: 'time', weekday: ['sat', 'sun'] }] }] }],
    actions: [{ stop: 'done' }, { action: 'nothing.here', enabled: false }],
  });
  assert.deepEqual(errors, []);
  // Disabled items stay as inert placeholders so trace paths keep matching the YAML indexes.
  assert.equal(automation!.triggers.length, 2);
  assert.equal(automation!.triggers[1]!.enabled, false);
  assert.equal(automation!.conditions[0]!.condition, 'or');
  assert.deepEqual(automation!.actions[1], { type: 'sequence', sequence: [], enabled: false });
});

test('non-Latin aliases get a stable hashed id', () => {
  const config = { alias: '回家开灯', triggers: [{ trigger: 'homeassistant', event: 'start' }], actions: [{ delay: 1 }] };
  const a = normalizeAutomation(config).automation!.id;
  assert.match(a, /^automation_[0-9a-f]{10}$/);
  assert.equal(normalizeAutomation(config).automation!.id, a);
});

test('time pattern and time-of-day scheduling', () => {
  const from = new Date(2026, 9, 13, 10, 7, 30);
  assert.equal(nextPatternMatch({ minutes: '/15' }, from).toTimeString().slice(0, 8), '10:15:00');
  assert.equal(nextPatternMatch({ seconds: '/20' }, from).toTimeString().slice(0, 8), '10:07:40');
  assert.equal(nextPatternMatch({ hours: '3' }, from).toString(), new Date(2026, 9, 14, 3, 0, 0).toString());
  assert.equal(nextTimeOfDay(7 * 3600, from).toString(), new Date(2026, 9, 14, 7).toString());
  assert.equal(nextTimeOfDay(23 * 3600, from).toString(), new Date(2026, 9, 13, 23).toString());
});
