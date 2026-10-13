import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTemplate, normalizeConfig, parseDiscoveryTopic, payloadEquals, planEndpoint, UnsupportedTemplateError } from '@livynq/adapter-mqtt';

test('template subset renders common discovery templates', () => {
  const payload = JSON.stringify({ temperature: '21.456', nested: { a: 1 }, 'odd-key': 'x', POWER: 'ON', occupancy: true });
  assert.equal(compileTemplate(undefined).render('raw'), 'raw');
  assert.equal(compileTemplate('{{ value }}').render('raw'), 'raw');
  assert.equal(compileTemplate('{{ value_json.temperature | float | round(1) }}').render(payload), 21.5);
  assert.equal(compileTemplate("{{ value_json['odd-key'] }}").render(payload), 'x');
  assert.equal(compileTemplate('{{value_json.POWER}}').render(payload), 'ON');
  assert.equal(compileTemplate('{{ value_json.nested.a | int }}').render(payload), 1);
  assert.equal(compileTemplate("{{ value_json.missing | default('n/a') }}").render(payload), 'n/a');
  assert.equal(compileTemplate('{{ value_json.temperature }}').render('not json'), undefined);
  assert.throws(() => compileTemplate('{% if value %}on{% endif %}'), UnsupportedTemplateError);
  assert.throws(() => compileTemplate('{{ value_json.a + 1 }}'), UnsupportedTemplateError);
  assert.ok(payloadEquals(compileTemplate('{{ value_json.occupancy }}').render(payload), true));
});

test('discovery topics, abbreviations and endpoint planning', () => {
  assert.deepEqual(parseDiscoveryTopic('homeassistant', 'homeassistant/light/node/obj/config'), { component: 'light', nodeId: 'node', objectId: 'obj' });
  assert.deepEqual(parseDiscoveryTopic('homeassistant', 'homeassistant/sensor/obj/config'), { component: 'sensor', objectId: 'obj' });
  assert.equal(parseDiscoveryTopic('homeassistant', 'zigbee2mqtt/bridge/state'), undefined);

  const cfg = normalizeConfig({ '~': 'tasmota/plug', stat_t: '~/STATE', cmd_t: '~/cmnd/POWER', uniq_id: 'u1', dev: { ids: ['abc'], mf: 'Tasmota', sa: 'Kitchen' } });
  assert.equal(cfg.state_topic, 'tasmota/plug/STATE');
  assert.equal(cfg.command_topic, 'tasmota/plug/cmnd/POWER');
  assert.equal(cfg.device?.manufacturer, 'Tasmota');
  assert.equal(cfg.device?.suggested_area, 'Kitchen');

  assert.equal(planEndpoint('light', { schema: 'json', supported_color_modes: ['xy', 'color_temp'] })?.deviceType, 'light.extendedColor');
  assert.equal(planEndpoint('light', { schema: 'json', supported_color_modes: ['color_temp'] })?.deviceType, 'light.colorTemperature');
  assert.equal(planEndpoint('light', { brightness_command_topic: 'x' })?.deviceType, 'light.dimmable');
  assert.equal(planEndpoint('light', {})?.deviceType, 'light.onOff');
  assert.equal(planEndpoint('switch', { device_class: 'outlet' })?.deviceType, 'plug.onOff');
  assert.equal(planEndpoint('binary_sensor', { device_class: 'door' })?.deviceType, 'binarySensor.contact');
  assert.equal(planEndpoint('sensor', { device_class: 'pressure' }), undefined);
});
