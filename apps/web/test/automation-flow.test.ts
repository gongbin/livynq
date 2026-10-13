import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAutomation } from '../../../packages/automation/src/schema.ts';
import {
  actionKind,
  branchesOf,
  conditionKind,
  duplicateAt,
  editable,
  entityValue,
  errorsByNode,
  getAt,
  insertAt,
  moveAt,
  nodeOfPath,
  parseErrorPath,
  removeAt,
  setAt,
  setGroupKind,
  setRepeatMode,
  toggleEnabled,
  traceMarks,
  tracePath,
  triggerIds,
  triggerKind,
} from '../src/lib/automation-flow.ts';
import { PICKER, servicesFor, statesFor } from '../src/lib/automation-catalog.ts';

const messy = {
  id: 'messy',
  alias: 'Messy',
  trigger: { platform: 'state', entity_id: 'binary_sensor.hall', to: 'on', id: 'hall' },
  condition: { or: { condition: 'state', entity_id: 'light.a', state: 'off' } },
  action: [
    { service: 'light.turn_on', entity_id: 'light.a', custom_key: 1 },
    { if: { condition: 'trigger', id: 'hall' }, then: { delay: 5 } },
    { parallel: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }, { sequence: { delay: 1 } }] },
    { choose: { conditions: { condition: 'time', after: '20:00' }, sequence: { delay: 2 } }, default: { stop: 'x' } },
    { repeat: { count: 2, sequence: { delay: 1 } } },
  ],
};

test('editable() lists every branch and keeps the meaning (the server agrees)', () => {
  const e = editable(messy);
  assert.equal(e.trigger, undefined);
  assert.ok(Array.isArray(e.triggers) && Array.isArray(e.conditions) && Array.isArray(e.actions));
  assert.deepEqual(getAt(e, ['conditions', 0, 'or']), [{ condition: 'state', entity_id: 'light.a', state: 'off' }]);
  assert.deepEqual(getAt(e, ['actions', 1, 'then']), [{ delay: 5 }]);
  assert.deepEqual(getAt(e, ['actions', 2, 'parallel', 0]), { sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] });
  assert.deepEqual(getAt(e, ['actions', 2, 'parallel', 1, 'sequence']), [{ delay: 1 }]);
  assert.equal(getAt(e, ['actions', 0, 'custom_key']), 1, 'unknown keys survive');
  assert.deepEqual(editable(e), e, 'idempotent');

  const a = normalizeAutomation(messy);
  const b = normalizeAutomation(e);
  // custom_key is an error on both sides; everything else must normalize identically.
  assert.deepEqual(b.errors, a.errors);
  assert.deepEqual(b.automation, a.automation);
});

test('kinds', () => {
  assert.equal(triggerKind({ platform: 'homeassistant', event: 'start' }), 'start');
  assert.equal(triggerKind({ trigger: 'nope' }), 'unknown');
  assert.equal(conditionKind({ not: [] }), 'not');
  assert.equal(conditionKind({ condition: 'template' }), 'unknown');
  assert.equal(actionKind({ service: 'light.turn_on' }), 'service');
  assert.equal(actionKind({ condition: 'state' }), 'condition');
  assert.equal(actionKind({ event: 'x' }), 'unknown');
});

test('branches of nested nodes', () => {
  const e = editable(messy);
  const ifB = branchesOf('action', getAt(e, ['actions', 1]), ['actions', 1]);
  assert.deepEqual(
    ifB.map((b) => [b.role, b.section, b.path.join('/'), b.absent ?? false]),
    [
      ['if', 'condition', 'actions/1/if', false],
      ['then', 'action', 'actions/1/then', false],
      ['else', 'action', 'actions/1/else', true],
    ],
  );
  const choose = branchesOf('action', getAt(e, ['actions', 3]), ['actions', 3]);
  assert.deepEqual(
    choose.map((b) => b.path.join('/')),
    ['actions/3/choose/0/conditions', 'actions/3/choose/0/sequence', 'actions/3/default'],
  );
  assert.deepEqual(
    branchesOf('condition', getAt(e, ['conditions', 0]), ['conditions', 0]).map((b) => b.path.join('/')),
    ['conditions/0/or'],
  );
  // A group condition used as an action
  assert.deepEqual(
    branchesOf('action', { condition: 'and', conditions: [] }, ['actions', 0]).map((b) => [b.section, b.path.join('/')]),
    [['condition', 'actions/0/conditions']],
  );
  assert.deepEqual(
    branchesOf('action', { parallel: [{ sequence: [] }, { sequence: [] }] }, ['actions', 0]).map((b) => b.path.join('/')),
    ['actions/0/parallel/0/sequence', 'actions/0/parallel/1/sequence'],
  );
});

test('immutable path operations', () => {
  const e = editable(messy);
  const frozen = JSON.stringify(e);
  const added = insertAt(e, ['actions', 1, 'else'], 0, { delay: 1 });
  assert.deepEqual(getAt(added, ['actions', 1, 'else']), [{ delay: 1 }], 'creates a missing list');
  const moved = moveAt(e, ['actions'], 0, 2);
  assert.equal(actionKind(getAt(moved, ['actions', 2])), 'service');
  assert.equal(actionKind(getAt(moved, ['actions', 0])), 'if');
  const removed = removeAt(e, ['actions', 0]);
  assert.equal((removed.actions as unknown[]).length, 4);
  const dup = duplicateAt(e, ['triggers', 0]);
  assert.equal(getAt(dup, ['triggers', 1, 'id']), 'hall_copy');
  const off = toggleEnabled(e, ['actions', 0]);
  assert.equal(getAt(off, ['actions', 0, 'enabled']), false);
  assert.equal(getAt(toggleEnabled(off, ['actions', 0]), ['actions', 0, 'enabled']), undefined);
  const cleared = setAt(e, ['actions', 0, 'custom_key'], undefined);
  assert.equal('custom_key' in (getAt(cleared, ['actions', 0]) as object), false);
  assert.equal(JSON.stringify(e), frozen, 'original untouched');
});

test('group and repeat conversions', () => {
  assert.deepEqual(setGroupKind({ or: [1], alias: 'x' }, 'and'), { and: [1], alias: 'x' });
  assert.deepEqual(setGroupKind({ condition: 'or', conditions: [1] }, 'not'), { condition: 'not', conditions: [1] });
  const r = setRepeatMode({ repeat: { count: 3, sequence: [{ delay: 1 }] } }, 'until');
  assert.deepEqual(r, { repeat: { until: [], sequence: [{ delay: 1 }] } });
  assert.deepEqual(setRepeatMode({ repeat: { while: [{ condition: 'state' }], sequence: [] } }, 'until'), { repeat: { until: [{ condition: 'state' }], sequence: [] } });
});

test('validation errors map to nodes', () => {
  assert.deepEqual(parseErrorPath('actions[1].then[0].target'), ['actions', 1, 'then', 0, 'target']);
  assert.deepEqual(parseErrorPath('actions[0].parallel[1][0].delay'), ['actions', 0, 'parallel', 1, 'sequence', 0, 'delay']);
  assert.deepEqual(nodeOfPath(['actions', 0, 'choose', 1]), ['actions', 0]);
  assert.equal(nodeOfPath(['alias']), null);
  const map = errorsByNode(['triggers[0].entity_id: is required', 'actions[1].then[0]: unknown action', 'id: is required']);
  assert.deepEqual(map.get('triggers/0'), [{ field: 'entity_id', message: 'is required' }]);
  assert.deepEqual(map.get('actions/1/then/0'), [{ field: '', message: 'unknown action' }]);
  assert.deepEqual(map.get(''), [{ field: 'id', message: 'is required' }]);
  // Real server output lands on real nodes
  const res = normalizeAutomation(editable({ alias: 'x', triggers: [{ trigger: 'state' }], actions: [{ if: [], then: [{ delay: 'soon' }] }] }));
  const byNode = errorsByNode(res.errors);
  assert.ok(byNode.has('triggers/0'), res.errors.join('\n'));
  assert.ok(byNode.has('actions/0/then/0'), res.errors.join('\n'));
});

test('trace paths and marks', () => {
  assert.deepEqual(tracePath('actions/1/then/0'), ['actions', 1, 'then', 0]);
  assert.deepEqual(tracePath('actions/0/parallel/1/0'), ['actions', 0, 'parallel', 1, 'sequence', 0]);
  const e = editable(messy);
  assert.deepEqual(tracePath('conditions/0/conditions/0', e), ['conditions', 0, 'or', 0]);
  assert.deepEqual(tracePath('actions/1/if/0', e), ['actions', 1, 'if', 0]);
  assert.deepEqual(tracePath('actions/4/condition/0', { actions: [0, 0, 0, 0, { condition: 'state' }] }), ['actions', 4]);
  const marks = traceMarks(e, {
    trigger: { vars: { idx: '0' } },
    conditions: [
      { path: 'conditions/0/conditions/0', result: true },
      { path: 'conditions/0', result: true },
      { path: 'actions/1/if/0', result: false },
    ],
    steps: [{ path: 'actions/0' }, { path: 'actions/1' }, { path: 'actions/2', error: 'boom' }],
  });
  assert.equal(marks.get('triggers/0'), 'ran');
  assert.equal(marks.get('conditions/0/or/0'), 'passed');
  assert.equal(marks.get('actions/1/if/0'), 'blocked');
  assert.equal(marks.get('actions/1'), 'ran');
  assert.equal(marks.get('actions/2'), 'failed');
});

test('catalog: every picker template is valid where it needs no entity', () => {
  for (const item of PICKER) {
    const node = item.create();
    const config = editable({
      alias: 'x',
      triggers: item.section === 'trigger' ? [node] : [{ trigger: 'time', at: '07:00' }],
      conditions: item.section === 'condition' ? [node] : [],
      actions: item.section === 'action' ? [node] : [{ delay: 1 }],
    });
    const errors = normalizeAutomation(config).errors.filter((e) => !/entity_id|\.id:|trigger.*id|webhook/.test(e));
    assert.deepEqual(errors, [], item.id);
  }
  assert.equal(servicesFor(['light']).domain, 'light');
  assert.equal(servicesFor(['light', 'switch']).domain, 'homeassistant');
  assert.equal(statesFor('binary_sensor', 'contact')[0]!.label, 'state.open');
  assert.deepEqual(triggerIds(editable(messy)), ['hall']);
  assert.equal(entityValue(['a']), 'a');
  assert.equal(entityValue([]), undefined);
});
