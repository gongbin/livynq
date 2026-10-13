import type { AttributeValue } from '@livynq/model';
import type { CommandHandler } from '@livynq/core';
import type { Component, DiscoveryConfig, EndpointPlan } from './discovery.ts';
import { compileStringTemplate, compileTemplate, payloadEquals, UnsupportedTemplateError, type CompiledTemplate } from './template.ts';

/** What a component wiring needs from the adapter, for one endpoint. */
export interface Wiring {
  config: DiscoveryConfig;
  plan: EndpointPlan;
  listen(topic: string | undefined, fn: (payload: string) => void): void;
  publish(topic: string | undefined, payload: string): Promise<void>;
  update(capability: string, attributes: Record<string, AttributeValue>): void;
  get(capability: string, attribute: string): AttributeValue | undefined;
  handle(capability: string, handlers: Record<string, CommandHandler>): void;
  warn(message: string): void;
}

const str = (v: unknown, fallback: string) => (v === undefined || v === null ? fallback : String(v));

/** Optional templates: an unsupported one disables just that feature (with a warning), not the entity. */
function optionalTemplate(w: Wiring, source: unknown, what: string): CompiledTemplate | undefined {
  try {
    return compileTemplate(source as string | undefined);
  } catch (err) {
    if (!(err instanceof UnsupportedTemplateError)) throw err;
    w.warn(`${what} ignored: ${err.message}`);
    return undefined;
  }
}

function commandTemplate(w: Wiring, source: unknown, what: string): (vars: Record<string, unknown>) => string {
  if (typeof source !== 'string') return (vars) => String(vars.value);
  try {
    const t = compileStringTemplate(source);
    return (vars) => t.render(vars);
  } catch (err) {
    if (!(err instanceof UnsupportedTemplateError)) throw err;
    w.warn(`${what} ignored: ${err.message}`);
    return (vars) => String(vars.value);
  }
}

const numberOf = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n;
};

export function wireExtended(component: Component, w: Wiring): void {
  const c = w.config;
  switch (component) {
    case 'cover': {
      const open = str(c.payload_open, 'OPEN');
      const close = str(c.payload_close, 'CLOSE');
      const stop = str(c.payload_stop, 'STOP');
      const posOpen = Number(c.position_open ?? 100);
      const posClosed = Number(c.position_closed ?? 0);
      const toPercent = (raw: number) => Math.round(((raw - posClosed) / (posOpen - posClosed)) * 100);
      const fromPercent = (pct: number) => Math.round(posClosed + (pct / 100) * (posOpen - posClosed));
      const stateTpl = optionalTemplate(w, c.value_template, 'cover value_template');
      const posTpl = optionalTemplate(w, c.position_template, 'cover position_template');
      const setPos = commandTemplate(w, c.set_position_template, 'cover set_position_template');
      const tiltTpl = optionalTemplate(w, c.tilt_status_template, 'cover tilt_status_template');
      const states: Record<string, string> = {
        [str(c.state_open, 'open')]: 'open',
        [str(c.state_closed, 'closed')]: 'closed',
        [str(c.state_opening, 'opening')]: 'opening',
        [str(c.state_closing, 'closing')]: 'closing',
        [str(c.state_stopped, 'stopped')]: 'stopped',
      };
      w.listen(c.state_topic, (payload) => {
        if (!stateTpl) return;
        const v = String(stateTpl.render(payload) ?? '');
        const state = states[v] ?? states[v.toLowerCase()];
        if (!state) return;
        const attrs: Record<string, AttributeValue> = { operationalStatus: state === 'opening' || state === 'closing' ? state : 'stopped' };
        // Without a position topic, open/closed is all we know.
        if (!c.position_topic && (state === 'open' || state === 'closed')) attrs.currentPosition = state === 'open' ? 100 : 0;
        w.update('windowCovering', attrs);
      });
      w.listen(c.position_topic as string | undefined, (payload) => {
        const n = numberOf(posTpl?.render(payload));
        if (n !== undefined) w.update('windowCovering', { currentPosition: Math.min(100, Math.max(0, toPercent(n))) });
      });
      w.listen(c.tilt_status_topic as string | undefined, (payload) => {
        const n = numberOf(tiltTpl?.render(payload));
        if (n !== undefined) w.update('windowCovering', { currentTilt: Math.min(100, Math.max(0, Math.round(n))) });
      });
      const send = (payload: string) => w.publish(c.command_topic, payload);
      w.handle('windowCovering', {
        open: () => send(open),
        close: () => send(close),
        stop: () => send(stop),
        goToPosition: (p) => {
          if (!c.set_position_topic) throw new Error('This cover does not support positions');
          w.update('windowCovering', { targetPosition: Number(p.position) });
          return w.publish(c.set_position_topic as string, setPos({ value: fromPercent(Number(p.position)), position: fromPercent(Number(p.position)) }));
        },
        goToTilt: (p) => {
          if (!c.tilt_command_topic) throw new Error('This cover does not support tilt');
          const tilt = commandTemplate(w, c.tilt_command_template, 'cover tilt_command_template');
          return w.publish(c.tilt_command_topic as string, tilt({ value: Number(p.tilt), tilt_position: Number(p.tilt) }));
        },
      });
      return;
    }
    case 'climate': {
      const modes = Array.isArray(c.modes) ? (c.modes as string[]) : ['off', 'heat'];
      const supported = modes.filter((m) => ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'].includes(m));
      // HA "heat_cool" means automatic range control
      if (modes.includes('heat_cool') && !supported.includes('auto')) supported.push('auto');
      w.update('thermostat', {
        supportedModes: supported.join(','),
        minSetpoint: Number(c.min_temp ?? 7),
        maxSetpoint: Number(c.max_temp ?? 35),
      });
      const modeTpl = optionalTemplate(w, c.mode_state_template, 'climate mode_state_template');
      const tempTpl = optionalTemplate(w, c.temperature_state_template, 'climate temperature_state_template');
      const currTpl = optionalTemplate(w, c.current_temperature_template, 'climate current_temperature_template');
      const actTpl = optionalTemplate(w, c.action_template, 'climate action_template');
      w.listen(c.mode_state_topic as string | undefined, (payload) => {
        const v = String(modeTpl?.render(payload) ?? '');
        const mode = v === 'heat_cool' ? 'auto' : v;
        if (['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'].includes(mode)) w.update('thermostat', { systemMode: mode });
      });
      w.listen(c.temperature_state_topic as string | undefined, (payload) => {
        const n = numberOf(tempTpl?.render(payload));
        if (n !== undefined) w.update('thermostat', { targetTemperature: n });
      });
      w.listen(c.current_temperature_topic as string | undefined, (payload) => {
        const n = numberOf(currTpl?.render(payload));
        if (n !== undefined) w.update('thermostat', { localTemperature: n });
      });
      w.listen(c.action_topic as string | undefined, (payload) => {
        const v = String(actTpl?.render(payload) ?? '');
        const map: Record<string, string> = { heating: 'heating', cooling: 'cooling', drying: 'drying', fan: 'fan', idle: 'idle', off: 'idle', preheating: 'heating', defrosting: 'heating' };
        if (map[v]) w.update('thermostat', { runningState: map[v]! });
      });
      const modeCmd = commandTemplate(w, c.mode_command_template, 'climate mode_command_template');
      const tempCmd = commandTemplate(w, c.temperature_command_template, 'climate temperature_command_template');
      w.handle('thermostat', {
        setSystemMode: (p) => {
          const mode = p.mode === 'auto' && !modes.includes('auto') && modes.includes('heat_cool') ? 'heat_cool' : String(p.mode);
          if (!modes.includes(mode)) throw new Error(`Mode ${p.mode} not supported (supported: ${modes.join(', ')})`);
          return w.publish(c.mode_command_topic as string | undefined, modeCmd({ value: mode }));
        },
        setTargetTemperature: (p) => w.publish(c.temperature_command_topic as string | undefined, tempCmd({ value: Number(p.temperature) })),
        setTemperatureRange: async (p) => {
          await w.publish(c.temperature_low_command_topic as string | undefined, String(p.low));
          await w.publish(c.temperature_high_command_topic as string | undefined, String(p.high));
        },
      });
      return;
    }
    case 'fan': {
      const on = str(c.payload_on, 'ON');
      const off = str(c.payload_off, 'OFF');
      const min = Number(c.speed_range_min ?? 1);
      const max = Number(c.speed_range_max ?? 100);
      const stateTpl = optionalTemplate(w, c.state_value_template ?? c.value_template, 'fan value_template');
      const pctTpl = optionalTemplate(w, c.percentage_value_template, 'fan percentage_value_template');
      const presetTpl = optionalTemplate(w, c.preset_mode_value_template, 'fan preset_mode_value_template');
      w.listen(c.state_topic, (payload) => {
        const v = stateTpl?.render(payload);
        if (payloadEquals(v, on)) w.update('onOff', { onOff: true });
        else if (payloadEquals(v, off)) w.update('onOff', { onOff: false });
      });
      w.listen(c.percentage_state_topic as string | undefined, (payload) => {
        const n = numberOf(pctTpl?.render(payload));
        if (n !== undefined) w.update('fanControl', { percentCurrent: n <= 0 ? 0 : Math.round(((n - min + 1) / (max - min + 1)) * 100) });
      });
      w.listen(c.preset_mode_state_topic as string | undefined, (payload) => {
        const v = String(presetTpl?.render(payload) ?? '');
        if (['off', 'low', 'medium', 'high', 'on', 'auto'].includes(v)) w.update('fanControl', { fanMode: v });
      });
      const pctCmd = commandTemplate(w, c.percentage_command_template, 'fan percentage_command_template');
      const presetCmd = commandTemplate(w, c.preset_mode_command_template, 'fan preset_mode_command_template');
      w.handle('onOff', {
        on: () => w.publish(c.command_topic, on),
        off: () => w.publish(c.command_topic, off),
        toggle: () => w.publish(c.command_topic, w.get('onOff', 'onOff') ? off : on),
      });
      w.handle('fanControl', {
        setPercent: (p) => {
          const pct = Number(p.percent);
          const raw = pct <= 0 ? 0 : Math.max(min, Math.round(min - 1 + (pct / 100) * (max - min + 1)));
          return w.publish(c.percentage_command_topic as string | undefined, pctCmd({ value: raw }));
        },
        setMode: (p) => {
          const presets = Array.isArray(c.preset_modes) ? (c.preset_modes as string[]) : [];
          if (!presets.includes(String(p.mode))) throw new Error(`Preset ${p.mode} not supported (supported: ${presets.join(', ') || 'none'})`);
          return w.publish(c.preset_mode_command_topic as string | undefined, presetCmd({ value: String(p.mode) }));
        },
      });
      return;
    }
    case 'lock': {
      const lock = str(c.payload_lock, 'LOCK');
      const unlock = str(c.payload_unlock, 'UNLOCK');
      const tpl = optionalTemplate(w, c.value_template, 'lock value_template');
      const states: [unknown, string][] = [
        [c.state_locked ?? 'LOCKED', 'locked'],
        [c.state_unlocked ?? 'UNLOCKED', 'unlocked'],
        [c.state_jammed ?? 'JAMMED', 'jammed'],
      ];
      w.listen(c.state_topic, (payload) => {
        const v = tpl?.render(payload);
        const match = states.find(([raw]) => payloadEquals(v, raw));
        if (match) w.update('doorLock', { lockState: match[1] });
      });
      w.handle('doorLock', { lock: () => w.publish(c.command_topic, lock), unlock: () => w.publish(c.command_topic, unlock) });
      return;
    }
    case 'device_automation': {
      // Zigbee2MQTT: topic zigbee2mqtt/<name>/action, payload "single"; Tasmota: type button_short_press.
      const expected = c.payload;
      const tpl = optionalTemplate(w, c.value_template, 'trigger value_template');
      w.listen(c.topic as string | undefined, (payload) => {
        const v = tpl ? tpl.render(payload) : payload;
        if (expected !== undefined && !payloadEquals(v, expected)) return;
        const action = String(expected ?? c.subtype ?? v);
        press(w, action, `${String(c.type ?? '')} ${String(c.subtype ?? '')} ${action}`);
      });
      return;
    }
    case 'event': {
      // { "event_type": "press" } payloads; Zigbee2MQTT templates like {{ {"event_type": value_json.action} | to_json }}.
      const key = typeof c.value_template === 'string' ? c.value_template.match(/"event_type"\s*:\s*value_json\.(\w+)/)?.[1] : undefined;
      const tpl = key ? undefined : optionalTemplate(w, c.value_template, 'event value_template');
      w.listen(c.state_topic, (payload) => {
        let type: unknown;
        try {
          const json = JSON.parse(payload) as Record<string, unknown>;
          type = key ? json[key] : json.event_type;
        } catch {
          type = undefined;
        }
        if (type === undefined && tpl) {
          const rendered = tpl.render(payload);
          type = typeof rendered === 'object' && rendered !== null ? (rendered as Record<string, unknown>).event_type : rendered;
        }
        if (typeof type === 'string' && type) press(w, type, type);
      });
      return;
    }
    default:
      w.warn(`component ${component} not wired`);
  }
}

/** Maps vendor action names onto single/double/long/release. */
function press(w: Wiring, action: string, hints: string): void {
  const h = hints.toLowerCase();
  const lastEvent = /release|_up\b|stop/.test(h) ? 'release' : /double|_2\b|2_click/.test(h) ? 'double' : /long|hold/.test(h) ? 'long' : 'single';
  w.update('genericSwitch', { lastEvent, lastEventAt: Date.now(), lastAction: action });
}
