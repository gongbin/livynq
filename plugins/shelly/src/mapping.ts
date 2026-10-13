import { DeviceTypes, levelToPercent, percentToLevel, type AttributeValue, type CapabilityId } from '@livynq/sdk';

/** Shelly Gen2+ components ("switch:0", "cover:1", …) ⇄ Livynq endpoints. */

export interface ComponentPlan {
  /** Component key, e.g. "switch:0" (stable; used for endpoint ids) */
  key: string;
  type: string;
  id: number;
  deviceType: string;
  capabilities: CapabilityId[];
  name?: string;
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };

const parseKey = (key: string) => {
  const m = /^([a-z0-9_]+):(\d+)$/.exec(key);
  return m ? { type: m[1]!, id: Number(m[2]) } : undefined;
};

/**
 * Plan endpoints from Shelly.GetStatus (+ names and modes from Shelly.GetConfig). Switches whose
 * consumption type is "lights" show up as lights.
 */
export function planComponents(status: Record<string, unknown>, config: Record<string, { name?: string | null; type?: string; consumption_type?: string }> = {}): ComponentPlan[] {
  const out: ComponentPlan[] = [];
  for (const [key, value] of Object.entries(status)) {
    const k = parseKey(key);
    if (!k || typeof value !== 'object' || value === null) continue;
    const s = value as Record<string, unknown>;
    const name = config[key]?.name ?? undefined;
    const base = { key, type: k.type, id: k.id, ...(name ? { name } : {}) };
    switch (k.type) {
      case 'switch': {
        const power = typeof s.apower === 'number';
        const light = config[key]?.consumption_type === 'lights';
        out.push({
          ...base,
          deviceType: light ? DeviceTypes.OnOffLight.id : power ? DeviceTypes.OnOffPlugInUnit.id : DeviceTypes.OnOffSwitch.id,
          capabilities: power && !light ? ['onOff', 'electricalPowerMeasurement'] : ['onOff'],
        });
        break;
      }
      case 'light':
        out.push({ ...base, deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] });
        break;
      case 'cover':
        out.push({ ...base, deviceType: DeviceTypes.WindowCovering.id, capabilities: ['windowCovering'] });
        break;
      case 'input':
        // Buttons only; switch-type inputs mirror the relay they control.
        if (config[key]?.type === 'button') {
          out.push({ ...base, deviceType: DeviceTypes.GenericSwitch.id, capabilities: ['genericSwitch'] });
        }
        break;
      case 'temperature':
        if (typeof s.tC === 'number') out.push({ ...base, deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] });
        break;
      case 'humidity':
        out.push({ ...base, deviceType: DeviceTypes.HumiditySensor.id, capabilities: ['relativeHumidityMeasurement'] });
        break;
      case 'illuminance':
        out.push({ ...base, deviceType: DeviceTypes.LightSensor.id, capabilities: ['illuminanceMeasurement'] });
        break;
      case 'devicepower':
        if (typeof (s.battery as { percent?: number } | undefined)?.percent === 'number') out.push({ ...base, deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'] });
        break;
      case 'pm1':
        // Shelly Plus PM Mini: a power meter without a relay
        out.push({ ...base, deviceType: DeviceTypes.PowerSensor.id, capabilities: ['electricalPowerMeasurement'] });
        break;
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** A (partial) component status from GetStatus or NotifyStatus → updates. */
export function statusToUpdates(plan: ComponentPlan, s: Record<string, unknown>): Update[] {
  const out: Update[] = [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  switch (plan.type) {
    case 'switch':
      if (typeof s.output === 'boolean') out.push({ capability: 'onOff', attributes: { onOff: s.output } });
      if (plan.capabilities.includes('electricalPowerMeasurement') && num(s.apower) !== undefined) out.push({ capability: 'electricalPowerMeasurement', attributes: { activePower: num(s.apower)! } });
      break;
    case 'light':
      if (typeof s.output === 'boolean') out.push({ capability: 'onOff', attributes: { onOff: s.output } });
      if (num(s.brightness) !== undefined) out.push({ capability: 'levelControl', attributes: { currentLevel: percentToLevel(num(s.brightness)!) } });
      break;
    case 'cover': {
      const attributes: Record<string, AttributeValue> = {};
      if (num(s.current_pos) !== undefined) attributes.currentPosition = Math.round(num(s.current_pos)!);
      else if (s.state === 'open') attributes.currentPosition = 100;
      else if (s.state === 'closed') attributes.currentPosition = 0;
      if (num(s.target_pos) !== undefined) attributes.targetPosition = Math.round(num(s.target_pos)!);
      if (typeof s.state === 'string') attributes.operationalStatus = s.state === 'opening' ? 'opening' : s.state === 'closing' ? 'closing' : 'stopped';
      if (Object.keys(attributes).length) out.push({ capability: 'windowCovering', attributes });
      break;
    }
    case 'temperature':
      if (num(s.tC) !== undefined) out.push({ capability: 'temperatureMeasurement', attributes: { measuredValue: Math.round(num(s.tC)! * 10) / 10 } });
      break;
    case 'humidity':
      if (num(s.rh) !== undefined) out.push({ capability: 'relativeHumidityMeasurement', attributes: { measuredValue: Math.round(num(s.rh)!) } });
      break;
    case 'illuminance':
      if (num(s.lux) !== undefined) out.push({ capability: 'illuminanceMeasurement', attributes: { measuredValue: num(s.lux)! } });
      break;
    case 'devicepower': {
      const pct = num((s.battery as { percent?: number } | undefined)?.percent);
      if (pct !== undefined) out.push({ capability: 'powerSource', attributes: { batPercentRemaining: pct, batChargeLevelLow: pct < 20 } });
      break;
    }
    case 'pm1':
      if (num(s.apower) !== undefined) out.push({ capability: 'electricalPowerMeasurement', attributes: { activePower: num(s.apower)! } });
      break;
  }
  return out;
}

/** NotifyEvent for an input in button mode → press. */
export function eventToUpdate(event: string): Update | undefined {
  const e = ({ single_push: 'single', double_push: 'double', triple_push: undefined, long_push: 'long', btn_up: 'release' } as Record<string, string | undefined>)[event];
  if (!e) return undefined;
  return { capability: 'genericSwitch', attributes: { lastEvent: e, lastEventAt: Date.now(), lastAction: event } };
}

export function componentCommands(plan: ComponentPlan): Record<string, string[]> {
  switch (plan.type) {
    case 'switch':
      return { onOff: ['on', 'off', 'toggle'] };
    case 'light':
      return { onOff: ['on', 'off', 'toggle'], levelControl: ['moveToLevel'] };
    case 'cover':
      return { windowCovering: ['open', 'close', 'stop', 'goToPosition'] };
  }
  return {};
}

/** Livynq command → Shelly RPC call. */
export function commandToRpc(plan: ComponentPlan, capability: string, command: string, params: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const id = plan.id;
  const T = plan.type === 'light' ? 'Light' : plan.type === 'switch' ? 'Switch' : 'Cover';
  switch (`${plan.type}:${capability}.${command}`) {
    case 'switch:onOff.on':
    case 'light:onOff.on':
      return { method: `${T}.Set`, params: { id, on: true } };
    case 'switch:onOff.off':
    case 'light:onOff.off':
      return { method: `${T}.Set`, params: { id, on: false } };
    case 'switch:onOff.toggle':
    case 'light:onOff.toggle':
      return { method: `${T}.Toggle`, params: { id } };
    case 'light:levelControl.moveToLevel':
      return { method: 'Light.Set', params: { id, on: true, brightness: Math.max(1, levelToPercent(Number(params.level))), ...(params.transitionTime !== undefined ? { transition_duration: Number(params.transitionTime) / 10 } : {}) } };
    case 'cover:windowCovering.open':
      return { method: 'Cover.Open', params: { id } };
    case 'cover:windowCovering.close':
      return { method: 'Cover.Close', params: { id } };
    case 'cover:windowCovering.stop':
      return { method: 'Cover.Stop', params: { id } };
    case 'cover:windowCovering.goToPosition':
      return { method: 'Cover.GoToPosition', params: { id, pos: Math.max(0, Math.min(100, Math.round(Number(params.position)))) } };
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}
