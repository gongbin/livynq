import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { callService, DemoAdapter, entityState, Home, LivynqError, type Confirmation } from '@livynq/core';

async function demo() {
  const home = new Home({ dataDir: ':memory:' });
  home.useAdapter(new DemoAdapter({ simulateSensors: false }));
  await home.start();
  return home;
}

test('commands above the caller risk limit wait for a human; approvals execute and are audited', async () => {
  const home = await demo();
  const events: Confirmation[] = [];
  home.bus.on('confirmation', (c) => events.push(c));
  const unlock = { deviceId: 'demo:front-lock', endpointId: 1, capability: 'doorLock', command: 'unlock' };
  const agent = { source: 'agent:claude', riskLimit: 'medium' as const };

  const light = await home.confirmations.guard({ deviceId: 'demo:bedroom-lamp', endpointId: 1, capability: 'onOff', command: 'on' }, agent);
  assert.deepEqual(light, { status: 'executed', risk: 'low' });

  const pending = await home.confirmations.guard(unlock, agent);
  assert.equal(pending.status, 'pending');
  const c = (pending as { confirmation: Confirmation }).confirmation;
  assert.equal(c.summary, 'Unlock Front Door Lock (Door Lock)');
  assert.equal(c.risk, 'high');
  assert.equal(home.registry.getAttribute('demo:front-lock', 1, 'doorLock', 'lockState'), 'locked', 'nothing happened yet');
  assert.equal(events[0]?.status, 'pending');

  const approved = await home.confirmations.approve(c.id, 'web:alice');
  assert.equal(approved.status, 'executed');
  assert.equal(home.registry.getAttribute('demo:front-lock', 1, 'doorLock', 'lockState'), 'unlocked');
  assert.equal(home.recentCommands(1)[0]?.source, 'agent:claude (approved by web:alice)');
  await assert.rejects(home.confirmations.approve(c.id, 'web:alice'), (e: LivynqError) => e.code === 'CONFLICT');

  const denied = await home.confirmations.guard({ ...unlock, command: 'lock' }, { source: 'agent:claude', riskLimit: 'low' });
  const d = home.confirmations.deny((denied as { confirmation: Confirmation }).confirmation.id, 'web:alice');
  assert.equal(d.status, 'denied');
  assert.equal(home.registry.getAttribute('demo:front-lock', 1, 'doorLock', 'lockState'), 'unlocked');

  // Garage-door style risk comes from the device type, admins are never blocked.
  assert.equal((await home.confirmations.guard(unlock, { source: 'web:alice', riskLimit: 'high' })).status, 'executed');
  await home.stop();
});

test('agent rate limit', async () => {
  const home = await demo();
  const cmd = { deviceId: 'demo:bedroom-lamp', endpointId: 1, capability: 'onOff', command: 'toggle' };
  for (let i = 0; i < 60; i++) await home.confirmations.guard(cmd, { source: 'agent:loop', riskLimit: 'low' });
  await assert.rejects(home.confirmations.guard(cmd, { source: 'agent:loop', riskLimit: 'low' }), /Rate limit/);
  await home.confirmations.guard(cmd, { source: 'web:alice', riskLimit: 'high' }); // people are not rate limited
  await home.stop();
});

test('HA services and entity states for covers, climate, fans and locks', async () => {
  const home = await demo();
  const call = (action: string, entity_id: string, data?: Record<string, unknown>) => callService(home, { action, target: { entity_id }, data }, 'test');

  await call('cover.set_cover_position', 'cover.living_room_curtain', { position: 50 });
  await sleep(20);
  assert.equal(entityState(home, 'cover.living_room_curtain')?.state, 'closing');
  for (let i = 0; i < 50 && home.registry.getAttribute('demo:living-curtain', 1, 'windowCovering', 'operationalStatus') !== 'stopped'; i++) await sleep(100);
  assert.deepEqual(entityState(home, 'cover.living_room_curtain')?.attributes.current_position, 50);

  await call('climate.set_temperature', 'climate.bedroom_ac', { temperature: 22, hvac_mode: 'cool' });
  const ac = entityState(home, 'climate.bedroom_ac')!;
  assert.equal(ac.state, 'cool');
  assert.equal(ac.attributes.temperature, 22);
  assert.equal(ac.attributes.hvac_action, 'cooling');
  assert.deepEqual(ac.attributes.hvac_modes, ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only']);
  await call('climate.turn_off', 'climate.bedroom_ac');
  assert.equal(entityState(home, 'climate.bedroom_ac')?.state, 'off');

  await call('fan.set_percentage', 'fan.desk_fan', { percentage: 80 });
  assert.equal(entityState(home, 'fan.desk_fan')?.state, 'on');
  assert.equal(entityState(home, 'fan.desk_fan')?.attributes.percentage, 80);
  await call('homeassistant.turn_off', 'fan.desk_fan');
  assert.equal(entityState(home, 'fan.desk_fan')?.state, 'off');

  await call('lock.unlock', 'lock.front_door_lock');
  assert.equal(entityState(home, 'lock.front_door_lock')?.state, 'unlocked');

  home.registry.updateState('demo:bedside-button', 1, 'genericSwitch', { lastEvent: 'double', lastEventAt: 1_800_000_000_000 }, 'test');
  const button = entityState(home, 'event.bedside_button')!;
  assert.equal(button.state, new Date(1_800_000_000_000).toISOString());
  assert.equal(button.attributes.event_type, 'double');
  await home.stop();
});
