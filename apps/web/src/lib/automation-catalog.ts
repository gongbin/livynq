import type { IconName } from '../components/icons.tsx';
import type { MessageKey } from './i18n.ts';
import type { NodeKind, Obj, Section } from './automation-flow.ts';

/**
 * What the visual editor offers: node templates for the "+" picker, the services the hub
 * supports per domain (mirrors packages/core/src/services.ts) and the states entities report
 * (mirrors packages/core/src/entity-state.ts). Pure data, no React.
 */

export interface PickerItem {
  id: string;
  section: Section;
  kind: NodeKind;
  icon: IconName;
  label: MessageKey;
  hint: MessageKey;
  group: MessageKey;
  create: () => Obj;
}

function token(n = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export const PICKER: PickerItem[] = [
  // triggers
  { id: 't.state', section: 'trigger', kind: 'state', icon: 'toggle', label: 'vis.k.t.state', hint: 'vis.h.t.state', group: 'vis.g.devices', create: () => ({ trigger: 'state', to: 'on' }) },
  { id: 't.numeric', section: 'trigger', kind: 'numeric_state', icon: 'gauge', label: 'vis.k.t.numeric', hint: 'vis.h.t.numeric', group: 'vis.g.devices', create: () => ({ trigger: 'numeric_state', above: 25 }) },
  { id: 't.time', section: 'trigger', kind: 'time', icon: 'clock', label: 'vis.k.t.time', hint: 'vis.h.t.time', group: 'vis.g.time', create: () => ({ trigger: 'time', at: '07:00:00' }) },
  { id: 't.pattern', section: 'trigger', kind: 'time_pattern', icon: 'repeat', label: 'vis.k.t.pattern', hint: 'vis.h.t.pattern', group: 'vis.g.time', create: () => ({ trigger: 'time_pattern', minutes: '/15' }) },
  { id: 't.sun', section: 'trigger', kind: 'sun', icon: 'sunset', label: 'vis.k.t.sun', hint: 'vis.h.t.sun', group: 'vis.g.time', create: () => ({ trigger: 'sun', event: 'sunset' }) },
  { id: 't.start', section: 'trigger', kind: 'start', icon: 'power', label: 'vis.k.t.start', hint: 'vis.h.t.start', group: 'vis.g.other', create: () => ({ trigger: 'homeassistant', event: 'start' }) },
  {
    id: 't.webhook',
    section: 'trigger',
    kind: 'webhook',
    icon: 'webhook',
    label: 'vis.k.t.webhook',
    hint: 'vis.h.t.webhook',
    group: 'vis.g.other',
    create: () => ({ trigger: 'webhook', webhook_id: `lvq_${token()}`, allowed_methods: ['POST'], local_only: true }),
  },
  // conditions
  { id: 'c.state', section: 'condition', kind: 'state', icon: 'toggle', label: 'vis.k.c.state', hint: 'vis.h.c.state', group: 'vis.g.devices', create: () => ({ condition: 'state', state: 'on' }) },
  { id: 'c.numeric', section: 'condition', kind: 'numeric_state', icon: 'gauge', label: 'vis.k.c.numeric', hint: 'vis.h.c.numeric', group: 'vis.g.devices', create: () => ({ condition: 'numeric_state', below: 20 }) },
  { id: 'c.time', section: 'condition', kind: 'time', icon: 'clock', label: 'vis.k.c.time', hint: 'vis.h.c.time', group: 'vis.g.time', create: () => ({ condition: 'time', after: '22:00:00', before: '06:00:00' }) },
  { id: 'c.weekday', section: 'condition', kind: 'time', icon: 'calendar', label: 'vis.k.c.weekday', hint: 'vis.h.c.weekday', group: 'vis.g.time', create: () => ({ condition: 'time', weekday: ['sat', 'sun'] }) },
  { id: 'c.sun', section: 'condition', kind: 'sun', icon: 'sun', label: 'vis.k.c.sun', hint: 'vis.h.c.sun', group: 'vis.g.time', create: () => ({ condition: 'sun', after: 'sunset' }) },
  { id: 'c.and', section: 'condition', kind: 'and', icon: 'listTree', label: 'vis.k.c.and', hint: 'vis.h.c.and', group: 'vis.g.logic', create: () => ({ condition: 'and', conditions: [] }) },
  { id: 'c.or', section: 'condition', kind: 'or', icon: 'split', label: 'vis.k.c.or', hint: 'vis.h.c.or', group: 'vis.g.logic', create: () => ({ condition: 'or', conditions: [] }) },
  { id: 'c.not', section: 'condition', kind: 'not', icon: 'circleX', label: 'vis.k.c.not', hint: 'vis.h.c.not', group: 'vis.g.logic', create: () => ({ condition: 'not', conditions: [] }) },
  { id: 'c.trigger', section: 'condition', kind: 'trigger', icon: 'zap', label: 'vis.k.c.trigger', hint: 'vis.h.c.trigger', group: 'vis.g.logic', create: () => ({ condition: 'trigger', id: '' }) },
  // actions
  { id: 'a.service', section: 'action', kind: 'service', icon: 'power', label: 'vis.k.a.service', hint: 'vis.h.a.service', group: 'vis.g.devices', create: () => ({ action: 'homeassistant.turn_on', target: {} }) },
  { id: 'a.automation', section: 'action', kind: 'service', icon: 'workflow', label: 'vis.k.a.automation', hint: 'vis.h.a.automation', group: 'vis.g.devices', create: () => ({ action: 'automation.trigger', target: {} }) },
  { id: 'a.notify', section: 'action', kind: 'service', icon: 'bell', label: 'vis.k.a.notify', hint: 'vis.h.a.notify', group: 'vis.g.other', create: () => ({ action: 'notify.notify', data: { message: '' } }) },
  { id: 'a.delay', section: 'action', kind: 'delay', icon: 'hourglass', label: 'vis.k.a.delay', hint: 'vis.h.a.delay', group: 'vis.g.time', create: () => ({ delay: '00:01:00' }) },
  { id: 'a.wait', section: 'action', kind: 'wait', icon: 'timer', label: 'vis.k.a.wait', hint: 'vis.h.a.wait', group: 'vis.g.time', create: () => ({ wait_for_trigger: [], timeout: '00:10:00' }) },
  { id: 'a.condition', section: 'action', kind: 'condition', icon: 'filter', label: 'vis.k.a.condition', hint: 'vis.h.a.condition', group: 'vis.g.logic', create: () => ({ condition: 'state', state: 'on' }) },
  { id: 'a.if', section: 'action', kind: 'if', icon: 'split', label: 'vis.k.a.if', hint: 'vis.h.a.if', group: 'vis.g.logic', create: () => ({ if: [], then: [], else: [] }) },
  { id: 'a.choose', section: 'action', kind: 'choose', icon: 'listTree', label: 'vis.k.a.choose', hint: 'vis.h.a.choose', group: 'vis.g.logic', create: () => ({ choose: [{ conditions: [], sequence: [] }] }) },
  { id: 'a.repeat', section: 'action', kind: 'repeat', icon: 'repeat', label: 'vis.k.a.repeat', hint: 'vis.h.a.repeat', group: 'vis.g.logic', create: () => ({ repeat: { count: 2, sequence: [] } }) },
  { id: 'a.parallel', section: 'action', kind: 'parallel', icon: 'columns', label: 'vis.k.a.parallel', hint: 'vis.h.a.parallel', group: 'vis.g.logic', create: () => ({ parallel: [{ sequence: [] }, { sequence: [] }] }) },
  { id: 'a.sequence', section: 'action', kind: 'sequence', icon: 'list', label: 'vis.k.a.sequence', hint: 'vis.h.a.sequence', group: 'vis.g.logic', create: () => ({ sequence: [] }) },
  { id: 'a.stop', section: 'action', kind: 'stop', icon: 'stop', label: 'vis.k.a.stop', hint: 'vis.h.a.stop', group: 'vis.g.logic', create: () => ({ stop: 'Stopped' }) },
];

/** Icon and label for a node already on the canvas. */
export function kindMeta(section: Section, kind: NodeKind, raw?: Obj): { icon: IconName; label: MessageKey } {
  if (section === 'action' && kind === 'service' && typeof raw?.action === 'string' && raw.action.startsWith('automation.')) return { icon: 'workflow', label: 'vis.k.a.automation' };
  if (section === 'action' && kind === 'service' && typeof raw?.action === 'string' && raw.action.startsWith('notify.')) return { icon: 'bell', label: 'vis.k.a.notify' };
  if (section === 'condition' && kind === 'time' && raw && raw.after === undefined && raw.before === undefined && raw.weekday !== undefined) return { icon: 'calendar', label: 'vis.k.c.weekday' };
  const item = PICKER.find((p) => p.section === section && p.kind === kind);
  if (item) return { icon: item.icon, label: item.label };
  if (section === 'action' && kind === 'condition') return { icon: 'filter', label: 'vis.k.a.condition' };
  return { icon: 'code', label: 'vis.k.unknown' };
}

// ---------------------------------------------------------------- services

export interface ServiceField {
  key: string;
  label: MessageKey;
  type: 'percent' | 'kelvin' | 'seconds' | 'number' | 'hvac' | 'text';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Must be present for the service to work. */
  required?: boolean;
}

export interface ServiceDef {
  service: string;
  label: MessageKey;
  fields?: ServiceField[];
}

const ON_OFF: ServiceDef[] = [
  { service: 'turn_on', label: 'vis.s.turn_on' },
  { service: 'turn_off', label: 'vis.s.turn_off' },
  { service: 'toggle', label: 'vis.s.toggle' },
];

export const SERVICES: Record<string, ServiceDef[]> = {
  light: [
    {
      service: 'turn_on',
      label: 'vis.s.turn_on',
      fields: [
        { key: 'brightness_pct', label: 'vis.f.brightness', type: 'percent', min: 1, max: 100, unit: '%' },
        { key: 'color_temp_kelvin', label: 'vis.f.colorTemp', type: 'kelvin', min: 2000, max: 6500, step: 100, unit: 'K' },
        { key: 'transition', label: 'vis.f.transition', type: 'seconds', min: 0, max: 300, unit: 's' },
      ],
    },
    { service: 'turn_off', label: 'vis.s.turn_off', fields: [{ key: 'transition', label: 'vis.f.transition', type: 'seconds', min: 0, max: 300, unit: 's' }] },
    { service: 'toggle', label: 'vis.s.toggle' },
  ],
  switch: ON_OFF,
  homeassistant: ON_OFF,
  fan: [
    { service: 'turn_on', label: 'vis.s.turn_on' },
    { service: 'turn_off', label: 'vis.s.turn_off' },
    { service: 'toggle', label: 'vis.s.toggle' },
    { service: 'set_percentage', label: 'vis.s.set_percentage', fields: [{ key: 'percentage', label: 'vis.f.speed', type: 'percent', min: 0, max: 100, unit: '%', required: true }] },
    { service: 'set_preset_mode', label: 'vis.s.set_preset_mode', fields: [{ key: 'preset_mode', label: 'vis.f.preset', type: 'text', required: true }] },
  ],
  cover: [
    { service: 'open_cover', label: 'vis.s.open_cover' },
    { service: 'close_cover', label: 'vis.s.close_cover' },
    { service: 'stop_cover', label: 'vis.s.stop_cover' },
    { service: 'toggle', label: 'vis.s.toggle' },
    { service: 'set_cover_position', label: 'vis.s.set_cover_position', fields: [{ key: 'position', label: 'vis.f.position', type: 'percent', min: 0, max: 100, unit: '%', required: true }] },
    { service: 'set_cover_tilt_position', label: 'vis.s.set_cover_tilt_position', fields: [{ key: 'tilt_position', label: 'vis.f.tilt', type: 'percent', min: 0, max: 100, unit: '%', required: true }] },
  ],
  climate: [
    {
      service: 'set_temperature',
      label: 'vis.s.set_temperature',
      fields: [
        { key: 'temperature', label: 'vis.f.temperature', type: 'number', min: 5, max: 35, step: 0.5, unit: '°C', required: true },
        { key: 'hvac_mode', label: 'vis.f.hvacMode', type: 'hvac' },
      ],
    },
    { service: 'set_hvac_mode', label: 'vis.s.set_hvac_mode', fields: [{ key: 'hvac_mode', label: 'vis.f.hvacMode', type: 'hvac', required: true }] },
    { service: 'turn_on', label: 'vis.s.turn_on' },
    { service: 'turn_off', label: 'vis.s.turn_off' },
  ],
  lock: [
    { service: 'lock', label: 'vis.s.lock' },
    { service: 'unlock', label: 'vis.s.unlock' },
  ],
  automation: [
    { service: 'trigger', label: 'vis.s.trigger' },
    { service: 'turn_on', label: 'vis.s.enable' },
    { service: 'turn_off', label: 'vis.s.disable' },
  ],
};

export const HVAC_MODES = ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'];

/** Domains a device action can target. */
export const CONTROLLABLE = new Set(Object.keys(SERVICES).filter((d) => d !== 'homeassistant'));

/**
 * Services for a set of target domains: the domain's own list, or the generic on/off/toggle
 * (`homeassistant.*`) when lights, switches and fans are mixed.
 */
export function servicesFor(domains: string[]): { domain: string; defs: ServiceDef[] } {
  const unique = [...new Set(domains)];
  if (unique.length === 1 && SERVICES[unique[0]!]) return { domain: unique[0]!, defs: SERVICES[unique[0]!]! };
  return { domain: 'homeassistant', defs: SERVICES.homeassistant! };
}

// ---------------------------------------------------------------- entity states

export interface StateOption {
  value: string;
  label: MessageKey;
}

/** States an entity reports, by domain and (for binary sensors) device class. */
export function statesFor(domain: string, kind?: string): StateOption[] {
  switch (domain) {
    case 'light':
    case 'switch':
    case 'fan':
    case 'automation':
      return [
        { value: 'on', label: 'common.on' },
        { value: 'off', label: 'common.off' },
      ];
    case 'binary_sensor':
      if (kind === 'contact')
        return [
          { value: 'on', label: 'state.open' },
          { value: 'off', label: 'state.closed' },
        ];
      if (kind === 'leak')
        return [
          { value: 'on', label: 'state.leak' },
          { value: 'off', label: 'state.dry' },
        ];
      return [
        { value: 'on', label: 'state.detected' },
        { value: 'off', label: 'state.clear' },
      ];
    case 'cover':
      return [
        { value: 'open', label: 'vis.st.open' },
        { value: 'closed', label: 'vis.st.closed' },
        { value: 'opening', label: 'vis.st.opening' },
        { value: 'closing', label: 'vis.st.closing' },
      ];
    case 'lock':
      return [
        { value: 'locked', label: 'vis.st.locked' },
        { value: 'unlocked', label: 'vis.st.unlocked' },
        { value: 'jammed', label: 'vis.st.jammed' },
      ];
    case 'climate':
      return HVAC_MODES.map((m) => ({ value: m, label: `vis.hvac.${m}` as MessageKey }));
  }
  return [];
}

/** Attributes worth offering per domain (numeric triggers and "attribute" fields). */
export const ATTRIBUTES: Record<string, string[]> = {
  light: ['brightness', 'color_temp_kelvin'],
  switch: ['current_power_w'],
  cover: ['current_position', 'current_tilt_position'],
  climate: ['current_temperature', 'temperature', 'hvac_action'],
  fan: ['percentage', 'preset_mode'],
  event: ['event_type'],
};

/** Domains whose state itself is a number (numeric triggers / conditions). */
export const NUMERIC_DOMAINS = new Set(['sensor']);

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
