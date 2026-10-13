import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeTar } from '@livynq/core';

/** A small but realistic Home Assistant config directory (registry formats as of HA 2025/2026). */
export const haFiles: Record<string, string> = {
  '.HA_VERSION': '2026.9.3\n',
  '.storage/core.config': JSON.stringify({ data: { latitude: 31.23, longitude: 121.47, time_zone: 'Asia/Shanghai', location_name: 'Home' } }),
  '.storage/core.area_registry': JSON.stringify({ data: { areas: [
    { id: 'living_room', name: 'Living Room', aliases: ['lounge'], floor_id: 'ground' },
    { id: 'kitchen', name: 'Kitchen', aliases: [], floor_id: 'ground' },
  ] } }),
  '.storage/core.floor_registry': JSON.stringify({ data: { floors: [{ floor_id: 'ground', name: 'Ground' }] } }),
  '.storage/core.device_registry': JSON.stringify({ data: { devices: [
    { id: 'dev-bulb', name: 'Hall Bulb', name_by_user: 'Lounge Lamp', manufacturer: 'Philips', model: 'LCT015', area_id: 'living_room', identifiers: [['mqtt', 'zigbee2mqtt_0x0017880104e45517']], disabled_by: null },
    { id: 'dev-sensor', name: 'Kitchen Sensor', name_by_user: null, manufacturer: 'Aqara', model: 'WSDCGQ11LM', area_id: 'kitchen', identifiers: [['mqtt', 'zigbee2mqtt_0x00158d0001a2b3c4']], disabled_by: null },
    { id: 'dev-later', name: 'Not Yet Discovered', name_by_user: null, manufacturer: null, model: null, area_id: null, identifiers: [['mqtt', 'zigbee2mqtt_0xdeadbeef']], disabled_by: null },
    { id: 'dev-hue', name: 'Hue Go', name_by_user: null, manufacturer: 'Signify', model: 'Go', area_id: 'living_room', identifiers: [['hue', 'abc']], disabled_by: null },
  ] } }),
  '.storage/core.entity_registry': JSON.stringify({ data: { entities: [
    { entity_id: 'light.lounge_lamp', unique_id: '0x0017880104e45517_light_zigbee2mqtt', platform: 'mqtt', device_id: 'dev-bulb', area_id: null, name: null, aliases: ['big light'], disabled_by: null },
    { entity_id: 'sensor.kitchen_temperature', unique_id: '0x00158d0001a2b3c4_temperature_zigbee2mqtt', platform: 'mqtt', device_id: 'dev-sensor', area_id: null, name: null, disabled_by: null },
    { entity_id: 'sensor.kitchen_pressure', unique_id: '0x00158d0001a2b3c4_pressure_zigbee2mqtt', platform: 'mqtt', device_id: 'dev-sensor', area_id: null, name: null, disabled_by: null },
    { entity_id: 'light.hue_go', unique_id: 'abc', platform: 'hue', device_id: 'dev-hue', area_id: null, name: null, disabled_by: null },
  ] } }),
  'configuration.yaml': ['homeassistant:', '  name: Home', 'mqtt:', '  password: !secret mqtt_password', 'automation: !include automations.yaml', 'script: !include scripts.yaml', 'scene: []'].join('\n'),
  'secrets.yaml': 'mqtt_password: hunter2\n',
  'scripts.yaml': 'bedtime:\n  sequence: []\n',
  'automations.yaml': [
    "- id: '1700000000001'",
    '  alias: Warm lounge when cold',
    '  trigger:',
    '    - platform: numeric_state',
    '      entity_id: sensor.kitchen_temperature',
    '      below: 18',
    '  action:',
    '    - service: light.turn_on',
    '      target: { area_id: living_room }',
    '      data: { color_temp_kelvin: 2700 }',
    "- id: '1700000000002'",
    '  alias: Templated',
    '  trigger: [{ platform: state, entity_id: light.lounge_lamp }]',
    "  action: [{ service: light.turn_on, target: { entity_id: light.lounge_lamp }, data: { brightness: '{{ 3 }}' } }]",
    "- id: '1700000000003'",
    '  alias: Blueprint',
    '  use_blueprint: { path: motion_light.yaml, input: {} }',
  ].join('\n'),
  'blueprints/automation/homeassistant/motion_light.yaml': 'blueprint: {}\n',
};

export function writeHaDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'ha-config-'));
  for (const [path, content] of Object.entries(haFiles)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Shaped like a Home Assistant backup: outer tar with backup.json + homeassistant.tar.gz (data/ prefix). */
export function writeHaBackup(): string {
  const inner = gzipSync(writeTar(Object.entries(haFiles).map(([path, content]) => ({ path: `data/${path}`, data: Buffer.from(content) }))));
  const outer = writeTar([
    { path: './backup.json', data: Buffer.from(JSON.stringify({ slug: 'abcd1234', name: 'Full backup' })) },
    { path: './homeassistant.tar.gz', data: inner },
  ]);
  const file = join(mkdtempSync(join(tmpdir(), 'ha-backup-')), 'abcd1234.tar');
  writeFileSync(file, outer);
  return file;
}
