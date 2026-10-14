import { DeviceTypes, clamp, degreesToHue, hueToDegrees, levelToPercent, percentToLevel, percentToSat, satToPercent, type AttributeValue, type CapabilityId } from '@livynq/sdk';
import type { Characteristic, Service } from 'hap-nodejs';
import { hap } from './hap.ts';

/**
 * HomeKit services of Homebridge accessories → Livynq endpoints (the reverse of the HomeKit
 * exporter's mapping). Each feature keeps the characteristics it reads and writes by role.
 */

export type FeatureKind =
  | 'light'
  | 'switch'
  | 'outlet'
  | 'fan'
  | 'cover'
  | 'garage'
  | 'lock'
  | 'thermostat'
  | 'heaterCooler'
  | 'temperature'
  | 'humidity'
  | 'lightLevel'
  | 'motion'
  | 'occupancy'
  | 'contact'
  | 'leak'
  | 'battery'
  | 'button';

export interface Feature {
  /** "<service UUID>:<subtype>" — stable endpoint key */
  key: string;
  kind: FeatureKind;
  service: Service;
  deviceType: string;
  capabilities: CapabilityId[];
  name?: string;
  chars: Record<string, Characteristic>;
}

export type Update = { capability: string; attributes: Record<string, AttributeValue> };
export type Write = { characteristic: Characteristic; value: unknown };

const S = () => hap.Service;
const C = () => hap.Characteristic;

/** The characteristic if the service has it (never creates optional ones, unlike getCharacteristic). */
function has(service: Service, type: { UUID: string }): Characteristic | undefined {
  return service.characteristics.find((c) => c.UUID === type.UUID);
}

function chars(service: Service, roles: Record<string, { UUID: string }>): Record<string, Characteristic> {
  const out: Record<string, Characteristic> = {};
  for (const [role, type] of Object.entries(roles)) {
    const c = has(service, type);
    if (c) out[role] = c;
  }
  return out;
}

const serviceName = (s: Service) => {
  const n = has(s, C().ConfiguredName)?.value ?? has(s, C().Name)?.value ?? s.displayName;
  return typeof n === 'string' && n.trim() ? n.trim() : undefined;
};

/** Plans one service; undefined when Livynq has no matching device type (it is reported as unsupported). */
export function planService(service: Service): Feature | undefined {
  const Sv = S();
  const Ch = C();
  const base = { key: `${service.UUID}:${service.subtype ?? ''}`, service, ...(serviceName(service) ? { name: serviceName(service) } : {}) };
  const u = service.UUID;
  if (u === Sv.Lightbulb.UUID) {
    const c = chars(service, { on: Ch.On, brightness: Ch.Brightness, ct: Ch.ColorTemperature, hue: Ch.Hue, saturation: Ch.Saturation });
    if (!c.on) return undefined;
    const color = Boolean(c.hue && c.saturation);
    const caps: CapabilityId[] = ['onOff'];
    if (c.brightness) caps.push('levelControl');
    if (color || c.ct) caps.push('colorControl');
    const deviceType = color ? DeviceTypes.ExtendedColorLight.id : c.ct && c.brightness ? DeviceTypes.ColorTemperatureLight.id : c.brightness ? DeviceTypes.DimmableLight.id : DeviceTypes.OnOffLight.id;
    return { ...base, kind: 'light', deviceType, capabilities: caps, chars: c };
  }
  if (u === Sv.Switch.UUID) return withChars(base, 'switch', DeviceTypes.OnOffSwitch.id, ['onOff'], chars(service, { on: Ch.On }), 'on');
  if (u === Sv.Outlet.UUID) return withChars(base, 'outlet', DeviceTypes.OnOffPlugInUnit.id, ['onOff'], chars(service, { on: Ch.On }), 'on');
  if (u === Sv.Fan.UUID || u === Sv.Fanv2.UUID || u === Sv.AirPurifier.UUID) {
    const c = chars(service, { on: Ch.On, active: Ch.Active, speed: Ch.RotationSpeed, purifierMode: Ch.TargetAirPurifierState });
    if (!c.on && !c.active) return undefined;
    return { ...base, kind: 'fan', deviceType: DeviceTypes.Fan.id, capabilities: ['onOff', 'fanControl'], chars: c };
  }
  if (u === Sv.WindowCovering.UUID || u === Sv.Door.UUID || u === Sv.Window.UUID) {
    return withChars(base, 'cover', DeviceTypes.WindowCovering.id, ['windowCovering'], chars(service, { current: Ch.CurrentPosition, target: Ch.TargetPosition, state: Ch.PositionState, hold: Ch.HoldPosition, obstructed: Ch.ObstructionDetected }), 'target');
  }
  if (u === Sv.GarageDoorOpener.UUID) {
    return withChars(base, 'garage', DeviceTypes.GarageDoor.id, ['windowCovering'], chars(service, { current: Ch.CurrentDoorState, target: Ch.TargetDoorState, obstructed: Ch.ObstructionDetected }), 'target');
  }
  if (u === Sv.LockMechanism.UUID) return withChars(base, 'lock', DeviceTypes.DoorLock.id, ['doorLock'], chars(service, { current: Ch.LockCurrentState, target: Ch.LockTargetState }), 'current');
  if (u === Sv.Thermostat.UUID) {
    return withChars(base, 'thermostat', DeviceTypes.Thermostat.id, ['thermostat'], chars(service, { current: Ch.CurrentTemperature, target: Ch.TargetTemperature, mode: Ch.TargetHeatingCoolingState, running: Ch.CurrentHeatingCoolingState }), 'mode');
  }
  if (u === Sv.HeaterCooler.UUID) {
    return withChars(
      base,
      'heaterCooler',
      DeviceTypes.AirConditioner.id,
      ['thermostat'],
      chars(service, { active: Ch.Active, current: Ch.CurrentTemperature, mode: Ch.TargetHeaterCoolerState, running: Ch.CurrentHeaterCoolerState, heat: Ch.HeatingThresholdTemperature, cool: Ch.CoolingThresholdTemperature }),
      'active',
    );
  }
  if (u === Sv.TemperatureSensor.UUID) return withChars(base, 'temperature', DeviceTypes.TemperatureSensor.id, ['temperatureMeasurement'], chars(service, { value: Ch.CurrentTemperature }), 'value');
  if (u === Sv.HumiditySensor.UUID) return withChars(base, 'humidity', DeviceTypes.HumiditySensor.id, ['relativeHumidityMeasurement'], chars(service, { value: Ch.CurrentRelativeHumidity }), 'value');
  if (u === Sv.LightSensor.UUID) return withChars(base, 'lightLevel', DeviceTypes.LightSensor.id, ['illuminanceMeasurement'], chars(service, { value: Ch.CurrentAmbientLightLevel }), 'value');
  if (u === Sv.MotionSensor.UUID) return withChars(base, 'motion', DeviceTypes.OccupancySensor.id, ['occupancySensing'], chars(service, { value: Ch.MotionDetected }), 'value');
  if (u === Sv.OccupancySensor.UUID) return withChars(base, 'occupancy', DeviceTypes.OccupancySensor.id, ['occupancySensing'], chars(service, { value: Ch.OccupancyDetected }), 'value');
  if (u === Sv.ContactSensor.UUID) return withChars(base, 'contact', DeviceTypes.ContactSensor.id, ['booleanState'], chars(service, { value: Ch.ContactSensorState }), 'value');
  if (u === Sv.LeakSensor.UUID) return withChars(base, 'leak', DeviceTypes.LeakSensor.id, ['booleanState'], chars(service, { value: Ch.LeakDetected }), 'value');
  if (u === Sv.Battery.UUID) return withChars(base, 'battery', DeviceTypes.BatterySensor.id, ['powerSource'], chars(service, { level: Ch.BatteryLevel, low: Ch.StatusLowBattery }), 'level');
  if (u === Sv.StatelessProgrammableSwitch.UUID || u === Sv.Doorbell.UUID) {
    return withChars(base, 'button', DeviceTypes.GenericSwitch.id, ['genericSwitch'], chars(service, { event: Ch.ProgrammableSwitchEvent }), 'event');
  }
  return undefined;
}

function withChars(base: Pick<Feature, 'key' | 'service' | 'name'>, kind: FeatureKind, deviceType: string, capabilities: CapabilityId[], c: Record<string, Characteristic>, required: string): Feature | undefined {
  return c[required] ? { ...base, kind, deviceType, capabilities, chars: c } : undefined;
}

/** Names of the services an accessory has that Livynq cannot map (for the "accessories" report). */
export const SKIPPED_SILENTLY = () => new Set([S().AccessoryInformation.UUID, S().ProtocolInformation.UUID]);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Current values of a feature → Livynq updates (from the characteristics' cached values). */
export function featureUpdates(f: Feature): Update[] {
  const v = (role: string) => f.chars[role]?.value;
  const out: Update[] = [];
  switch (f.kind) {
    case 'light': {
      out.push({ capability: 'onOff', attributes: { onOff: Boolean(v('on')) } });
      const bri = num(v('brightness'));
      if (bri !== undefined) out.push({ capability: 'levelControl', attributes: { currentLevel: percentToLevel(bri) } });
      const color: Record<string, AttributeValue> = {};
      const ct = num(v('ct'));
      if (ct !== undefined) color.colorTemperatureMireds = clamp(Math.round(ct), 50, 1000);
      if (f.chars.ct) {
        const p = f.chars.ct.props;
        if (num(p.minValue) !== undefined) color.colorTempPhysicalMinMireds = clamp(p.minValue!, 50, 1000);
        if (num(p.maxValue) !== undefined) color.colorTempPhysicalMaxMireds = clamp(p.maxValue!, 50, 1000);
      }
      const hue = num(v('hue'));
      const sat = num(v('saturation'));
      if (hue !== undefined && sat !== undefined) {
        color.currentHue = degreesToHue(hue);
        color.currentSaturation = percentToSat(sat);
      }
      if (Object.keys(color).length) color.colorMode = f.chars.hue && (!f.chars.ct || (sat ?? 0) > 0) ? 'hs' : 'ct';
      if (Object.keys(color).length > 1) out.push({ capability: 'colorControl', attributes: color });
      break;
    }
    case 'switch':
    case 'outlet':
      out.push({ capability: 'onOff', attributes: { onOff: Boolean(v('on')) } });
      break;
    case 'fan': {
      const on = f.chars.active ? Number(v('active')) === 1 : Boolean(v('on'));
      out.push({ capability: 'onOff', attributes: { onOff: on } });
      const fan: Record<string, AttributeValue> = {};
      const speed = num(v('speed'));
      if (speed !== undefined) fan.percentCurrent = clamp(Math.round(speed), 0, 100);
      if (!on) fan.fanMode = 'off';
      else if (f.chars.purifierMode && Number(v('purifierMode')) === 1) fan.fanMode = 'auto';
      else fan.fanMode = speed === undefined ? 'on' : speed <= 34 ? 'low' : speed <= 67 ? 'medium' : 'high';
      out.push({ capability: 'fanControl', attributes: fan });
      break;
    }
    case 'cover': {
      const a: Record<string, AttributeValue> = {};
      const cur = num(v('current'));
      const target = num(v('target'));
      if (cur !== undefined) a.currentPosition = clamp(Math.round(cur), 0, 100);
      if (target !== undefined) a.targetPosition = clamp(Math.round(target), 0, 100);
      const st = num(v('state'));
      // PositionState: 0 decreasing, 1 increasing, 2 stopped
      if (st !== undefined) a.operationalStatus = st === 0 ? 'closing' : st === 1 ? 'opening' : 'stopped';
      if (f.chars.obstructed) a.obstructed = Boolean(v('obstructed'));
      out.push({ capability: 'windowCovering', attributes: a });
      break;
    }
    case 'garage': {
      // CurrentDoorState: 0 open, 1 closed, 2 opening, 3 closing, 4 stopped; TargetDoorState: 0 open, 1 closed
      const cur = num(v('current'));
      const target = num(v('target'));
      const a: Record<string, AttributeValue> = {};
      if (cur !== undefined) {
        a.currentPosition = cur === 0 ? 100 : cur === 1 ? 0 : 50;
        a.operationalStatus = cur === 2 ? 'opening' : cur === 3 ? 'closing' : 'stopped';
      }
      if (target !== undefined) a.targetPosition = target === 0 ? 100 : 0;
      if (f.chars.obstructed) a.obstructed = Boolean(v('obstructed'));
      out.push({ capability: 'windowCovering', attributes: a });
      break;
    }
    case 'lock': {
      const s = num(v('current'));
      out.push({ capability: 'doorLock', attributes: { lockState: s === 0 ? 'unlocked' : s === 1 ? 'locked' : s === 2 ? 'jammed' : 'unknown' } });
      break;
    }
    case 'thermostat': {
      const t: Record<string, AttributeValue> = {};
      const cur = num(v('current'));
      const target = num(v('target'));
      if (cur !== undefined) t.localTemperature = Math.round(cur * 10) / 10;
      if (target !== undefined) t.targetTemperature = target;
      const modes = ['off', 'heat', 'cool', 'auto'] as const;
      const mode = num(v('mode'));
      if (mode !== undefined) t.systemMode = modes[mode] ?? 'auto';
      const valid = f.chars.mode?.props.validValues;
      t.supportedModes = (valid?.length ? valid.map((x) => modes[x]).filter(Boolean) : modes).join(',');
      const running = num(v('running'));
      if (running !== undefined) t.runningState = running === 1 ? 'heating' : running === 2 ? 'cooling' : 'idle';
      const p = f.chars.target?.props;
      if (num(p?.minValue) !== undefined) t.minSetpoint = p!.minValue!;
      if (num(p?.maxValue) !== undefined) t.maxSetpoint = p!.maxValue!;
      out.push({ capability: 'thermostat', attributes: t });
      break;
    }
    case 'heaterCooler': {
      const t: Record<string, AttributeValue> = {};
      const cur = num(v('current'));
      if (cur !== undefined) t.localTemperature = Math.round(cur * 10) / 10;
      const active = Number(v('active')) === 1;
      // TargetHeaterCoolerState: 0 auto, 1 heat, 2 cool
      const mode = (['auto', 'heat', 'cool'] as const)[num(v('mode')) ?? 0] ?? 'auto';
      t.systemMode = active ? mode : 'off';
      const heat = num(v('heat'));
      const cool = num(v('cool'));
      if (mode === 'heat' && heat !== undefined) t.targetTemperature = heat;
      else if (mode === 'cool' && cool !== undefined) t.targetTemperature = cool;
      else if (mode === 'auto') {
        if (heat !== undefined) t.targetTemperatureLow = heat;
        if (cool !== undefined) t.targetTemperatureHigh = cool;
        if (heat !== undefined && cool !== undefined) t.targetTemperature = Math.round(((heat + cool) / 2) * 10) / 10;
      }
      const valid = f.chars.mode?.props.validValues;
      t.supportedModes = ['off', ...(valid?.length ? valid.map((x) => ['auto', 'heat', 'cool'][x]).filter(Boolean) : ['auto', 'heat', 'cool'])].join(',');
      // CurrentHeaterCoolerState: 0 inactive, 1 idle, 2 heating, 3 cooling
      const running = num(v('running'));
      if (running !== undefined) t.runningState = running === 2 ? 'heating' : running === 3 ? 'cooling' : 'idle';
      out.push({ capability: 'thermostat', attributes: t });
      break;
    }
    case 'temperature': {
      const x = num(v('value'));
      if (x !== undefined) out.push({ capability: 'temperatureMeasurement', attributes: { measuredValue: Math.round(x * 10) / 10 } });
      break;
    }
    case 'humidity': {
      const x = num(v('value'));
      if (x !== undefined) out.push({ capability: 'relativeHumidityMeasurement', attributes: { measuredValue: Math.round(x) } });
      break;
    }
    case 'lightLevel': {
      const x = num(v('value'));
      if (x !== undefined) out.push({ capability: 'illuminanceMeasurement', attributes: { measuredValue: x } });
      break;
    }
    case 'motion':
      out.push({ capability: 'occupancySensing', attributes: { occupied: Boolean(v('value')) } });
      break;
    case 'occupancy':
      out.push({ capability: 'occupancySensing', attributes: { occupied: Number(v('value')) === 1 } });
      break;
    case 'contact':
      // ContactSensorState 0 = contact detected (closed) → stateValue true
      out.push({ capability: 'booleanState', attributes: { stateValue: Number(v('value')) === 0 } });
      break;
    case 'leak':
      out.push({ capability: 'booleanState', attributes: { stateValue: Number(v('value')) === 1 } });
      break;
    case 'battery': {
      const level = num(v('level'));
      if (level !== undefined) out.push({ capability: 'powerSource', attributes: { batPercentRemaining: level, batChargeLevelLow: f.chars.low ? Number(v('low')) === 1 : level < 20 } });
      break;
    }
    case 'button':
      // Presses only arrive as change events (buttonUpdate); the cached value would replay an old press.
      break;
  }
  return out;
}

/** ProgrammableSwitchEvent value → a press. */
export function buttonUpdate(value: unknown): Update | undefined {
  const e = (['single', 'double', 'long'] as const)[Number(value)];
  return e ? { capability: 'genericSwitch', attributes: { lastEvent: e, lastEventAt: Date.now(), lastAction: `${e}_press` } } : undefined;
}

export function featureCommands(f: Feature): Record<string, string[]> {
  switch (f.kind) {
    case 'light':
      return {
        onOff: ['on', 'off', 'toggle'],
        ...(f.chars.brightness ? { levelControl: ['moveToLevel'] } : {}),
        ...(f.chars.ct || f.chars.hue ? { colorControl: [...(f.chars.ct ? ['moveToColorTemperature'] : []), ...(f.chars.hue && f.chars.saturation ? ['moveToHueAndSaturation'] : [])] } : {}),
      };
    case 'switch':
    case 'outlet':
      return { onOff: ['on', 'off', 'toggle'] };
    case 'fan':
      return { onOff: ['on', 'off', 'toggle'], fanControl: ['setPercent', 'setMode'] };
    case 'cover':
      return { windowCovering: ['open', 'close', 'stop', 'goToPosition'] };
    case 'garage':
      return { windowCovering: ['open', 'close'] };
    case 'lock':
      return { doorLock: ['lock', 'unlock'] };
    case 'thermostat':
      return { thermostat: ['setSystemMode', 'setTargetTemperature'] };
    case 'heaterCooler':
      return { thermostat: ['setSystemMode', 'setTargetTemperature', 'setTemperatureRange'] };
  }
  return {};
}

const clampTo = (c: Characteristic | undefined, value: number) => {
  if (!c) return value;
  const { minValue, maxValue, minStep } = c.props;
  let v = value;
  if (num(minStep) !== undefined && minStep! > 0) v = Math.round(v / minStep!) * minStep!;
  if (num(minValue) !== undefined) v = Math.max(minValue!, v);
  if (num(maxValue) !== undefined) v = Math.min(maxValue!, v);
  return v;
};

/** Livynq command → characteristic writes (order matters: e.g. turn on before setting brightness). */
export function commandToWrites(f: Feature, capability: string, command: string, params: Record<string, unknown>): Write[] {
  const c = f.chars;
  const w = (ch: Characteristic | undefined, value: unknown): Write[] => (ch ? [{ characteristic: ch, value }] : []);
  const power = (on: boolean) => (c.active ? w(c.active, on ? 1 : 0) : w(c.on, on));
  const isOn = () => (c.active ? Number(c.active.value) === 1 : Boolean(c.on?.value));
  switch (`${capability}.${command}`) {
    case 'onOff.on':
      return power(true);
    case 'onOff.off':
      return power(false);
    case 'onOff.toggle':
      return power(!isOn());
    case 'levelControl.moveToLevel':
      return [...(isOn() ? [] : power(true)), ...w(c.brightness, clampTo(c.brightness, Math.max(1, levelToPercent(Number(params.level)))))];
    case 'colorControl.moveToColorTemperature':
      return [...(isOn() ? [] : power(true)), ...w(c.ct, clampTo(c.ct, Math.round(Number(params.colorTemperatureMireds))))];
    case 'colorControl.moveToHueAndSaturation':
      return [...(isOn() ? [] : power(true)), ...w(c.hue, hueToDegrees(Number(params.hue))), ...w(c.saturation, satToPercent(Number(params.saturation)))];
    case 'fanControl.setPercent': {
      const pct = clamp(Number(params.percent), 0, 100);
      if (pct === 0) return power(false);
      return [...(isOn() ? [] : power(true)), ...(c.purifierMode ? w(c.purifierMode, 0) : []), ...w(c.speed, clampTo(c.speed, pct))];
    }
    case 'fanControl.setMode': {
      const mode = String(params.mode);
      if (mode === 'off') return power(false);
      if (mode === 'on') return power(true);
      if (mode === 'auto') return [...(isOn() ? [] : power(true)), ...w(c.purifierMode, 1)];
      return commandToWrites(f, 'fanControl', 'setPercent', { percent: mode === 'low' ? 33 : mode === 'medium' ? 66 : 100 });
    }
    case 'windowCovering.open':
      return f.kind === 'garage' ? w(c.target, 0) : w(c.target, 100);
    case 'windowCovering.close':
      return f.kind === 'garage' ? w(c.target, 1) : w(c.target, 0);
    case 'windowCovering.stop':
      return c.hold ? w(c.hold, true) : w(c.target, num(c.current?.value) ?? num(c.target?.value) ?? 0);
    case 'windowCovering.goToPosition':
      return w(c.target, clamp(Math.round(Number(params.position)), 0, 100));
    case 'doorLock.lock':
      return w(c.target, 1);
    case 'doorLock.unlock':
      return w(c.target, 0);
    case 'thermostat.setSystemMode': {
      const mode = String(params.mode);
      if (f.kind === 'thermostat') {
        const v = ['off', 'heat', 'cool', 'auto'].indexOf(mode);
        if (v < 0) throw new Error(`Mode ${mode} is not supported by this thermostat`);
        return w(c.mode, v);
      }
      if (mode === 'off') return w(c.active, 0);
      const v = ['auto', 'heat', 'cool'].indexOf(mode);
      if (v < 0) throw new Error(`Mode ${mode} is not supported by this device`);
      return [...w(c.active, 1), ...w(c.mode, v)];
    }
    case 'thermostat.setTargetTemperature': {
      const t = Number(params.temperature);
      if (f.kind === 'thermostat') return w(c.target, clampTo(c.target, t));
      const mode = num(c.mode?.value) ?? 0;
      if (mode === 1) return w(c.heat, clampTo(c.heat, t));
      if (mode === 2) return w(c.cool, clampTo(c.cool, t));
      return [...w(c.heat, clampTo(c.heat, t - 1)), ...w(c.cool, clampTo(c.cool, t + 1))];
    }
    case 'thermostat.setTemperatureRange':
      return [...w(c.heat, clampTo(c.heat, Number(params.low))), ...w(c.cool, clampTo(c.cool, Number(params.high)))];
  }
  throw new Error(`Unsupported command ${capability}.${command}`);
}
