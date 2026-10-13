import { t, type ValueSchema } from './schema.ts';

/** How dangerous it is to let an automated caller (agent, script) invoke a capability's commands. */
export type Risk = 'low' | 'medium' | 'high';

export interface CapabilityDefinition {
  id: string;
  /** Matter cluster id when the capability mirrors a Matter cluster. */
  matterCluster?: number;
  description: string;
  attributes: Record<string, ValueSchema>;
  commands: Record<string, ValueSchema>;
  events?: Record<string, ValueSchema>;
  risk: Risk;
}

function define<const C extends CapabilityDefinition>(c: C): C {
  return c;
}

// Levels follow Matter semantics: 1..254 for brightness, hue/saturation 0..254.
export const OnOff = define({
  id: 'onOff',
  matterCluster: 0x0006,
  description: 'On/off switching',
  attributes: { onOff: t.boolean('true when on') },
  commands: { on: t.void(), off: t.void(), toggle: t.void() },
  risk: 'low',
});

export const LevelControl = define({
  id: 'levelControl',
  matterCluster: 0x0008,
  description: 'Brightness / level, 1..254 (Matter scale)',
  attributes: { currentLevel: t.int(1, 254) },
  commands: {
    moveToLevel: t.object({ level: t.int(1, 254), transitionTime: t.int(0, 65535, { unit: 'ds', description: 'tenths of a second' }) }, ['level']),
  },
  risk: 'low',
});

export const ColorControl = define({
  id: 'colorControl',
  matterCluster: 0x0300,
  description: 'Color temperature and hue/saturation',
  attributes: {
    colorMode: t.enum(['hs', 'xy', 'ct']),
    currentHue: t.int(0, 254),
    currentSaturation: t.int(0, 254),
    colorTemperatureMireds: t.int(50, 1000, { unit: 'mired' }),
    colorTempPhysicalMinMireds: t.int(50, 1000, { unit: 'mired' }),
    colorTempPhysicalMaxMireds: t.int(50, 1000, { unit: 'mired' }),
  },
  commands: {
    moveToColorTemperature: t.object({ colorTemperatureMireds: t.int(50, 1000), transitionTime: t.int(0, 65535) }, ['colorTemperatureMireds']),
    moveToHueAndSaturation: t.object({ hue: t.int(0, 254), saturation: t.int(0, 254), transitionTime: t.int(0, 65535) }, ['hue', 'saturation']),
  },
  risk: 'low',
});

export const TemperatureMeasurement = define({
  id: 'temperatureMeasurement',
  matterCluster: 0x0402,
  description: 'Temperature in °C',
  attributes: { measuredValue: t.number({ unit: '°C' }) },
  commands: {},
  risk: 'low',
});

export const RelativeHumidityMeasurement = define({
  id: 'relativeHumidityMeasurement',
  matterCluster: 0x0405,
  description: 'Relative humidity in %',
  attributes: { measuredValue: t.number({ minimum: 0, maximum: 100, unit: '%' }) },
  commands: {},
  risk: 'low',
});

export const IlluminanceMeasurement = define({
  id: 'illuminanceMeasurement',
  matterCluster: 0x0400,
  description: 'Illuminance in lux',
  attributes: { measuredValue: t.number({ minimum: 0, unit: 'lx' }) },
  commands: {},
  risk: 'low',
});

export const OccupancySensing = define({
  id: 'occupancySensing',
  matterCluster: 0x0406,
  description: 'Motion / presence detection',
  attributes: { occupied: t.boolean() },
  commands: {},
  risk: 'low',
});

export const BooleanState = define({
  id: 'booleanState',
  matterCluster: 0x0045,
  description: 'Contact / leak style boolean sensor; stateValue=true means contact closed for contact sensors',
  attributes: { stateValue: t.boolean() },
  commands: {},
  risk: 'low',
});

export const PowerSource = define({
  id: 'powerSource',
  matterCluster: 0x002f,
  description: 'Battery level',
  attributes: { batPercentRemaining: t.number({ minimum: 0, maximum: 100, unit: '%' }), batChargeLevelLow: t.boolean() },
  commands: {},
  risk: 'low',
});

export const ElectricalPowerMeasurement = define({
  id: 'electricalPowerMeasurement',
  matterCluster: 0x0090,
  description: 'Active power in W',
  attributes: { activePower: t.number({ unit: 'W' }) },
  commands: {},
  risk: 'low',
});

// Cover position uses 0..100 with 100 = fully open (HomeKit / Home Assistant convention);
// Matter's WindowCovering uses percent closed, the Matter adapter/exporter inverts it.
export const WindowCovering = define({
  id: 'windowCovering',
  matterCluster: 0x0102,
  description: 'Curtains, blinds, shades, garage doors. Position 0..100, 100 = fully open',
  attributes: {
    currentPosition: t.int(0, 100, { unit: '%' }),
    targetPosition: t.int(0, 100, { unit: '%' }),
    currentTilt: t.int(0, 100, { unit: '%' }),
    operationalStatus: t.enum(['stopped', 'opening', 'closing']),
    obstructed: t.boolean(),
  },
  commands: {
    open: t.void(),
    close: t.void(),
    stop: t.void(),
    goToPosition: t.object({ position: t.int(0, 100) }, ['position']),
    goToTilt: t.object({ tilt: t.int(0, 100) }, ['tilt']),
  },
  risk: 'medium',
});

export const Thermostat = define({
  id: 'thermostat',
  matterCluster: 0x0201,
  description: 'Heating / cooling / air conditioning, temperatures in °C',
  attributes: {
    localTemperature: t.number({ unit: '°C' }),
    targetTemperature: t.number({ unit: '°C' }),
    targetTemperatureLow: t.number({ unit: '°C' }),
    targetTemperatureHigh: t.number({ unit: '°C' }),
    systemMode: t.enum(['off', 'heat', 'cool', 'auto', 'dry', 'fan_only']),
    supportedModes: t.string('comma separated systemMode values'),
    runningState: t.enum(['idle', 'heating', 'cooling', 'drying', 'fan']),
    minSetpoint: t.number({ unit: '°C' }),
    maxSetpoint: t.number({ unit: '°C' }),
  },
  commands: {
    setSystemMode: t.object({ mode: t.enum(['off', 'heat', 'cool', 'auto', 'dry', 'fan_only']) }, ['mode']),
    setTargetTemperature: t.object({ temperature: t.number({ minimum: 5, maximum: 35 }) }, ['temperature']),
    setTemperatureRange: t.object({ low: t.number({ minimum: 5, maximum: 35 }), high: t.number({ minimum: 5, maximum: 35 }) }, ['low', 'high']),
  },
  risk: 'medium',
});

export const FanControl = define({
  id: 'fanControl',
  matterCluster: 0x0202,
  description: 'Fan speed (percent) and mode',
  attributes: {
    percentCurrent: t.int(0, 100, { unit: '%' }),
    fanMode: t.enum(['off', 'low', 'medium', 'high', 'on', 'auto']),
  },
  commands: {
    setPercent: t.object({ percent: t.int(0, 100) }, ['percent']),
    setMode: t.object({ mode: t.enum(['off', 'low', 'medium', 'high', 'on', 'auto']) }, ['mode']),
  },
  risk: 'low',
});

export const DoorLock = define({
  id: 'doorLock',
  matterCluster: 0x0101,
  description: 'Door lock',
  attributes: { lockState: t.enum(['locked', 'unlocked', 'jammed', 'unknown']) },
  commands: { lock: t.void(), unlock: t.void() },
  risk: 'high',
});

/** Stateless buttons / remotes. Each press updates lastEvent + lastEventAt (so repeated presses are distinct changes). */
export const GenericSwitch = define({
  id: 'genericSwitch',
  matterCluster: 0x003b,
  description: 'Wireless button / remote: last press',
  attributes: {
    lastEvent: t.enum(['single', 'double', 'long', 'release']),
    lastEventAt: t.number({ description: 'epoch ms of the last press' }),
    lastAction: t.string('raw action name reported by the device, e.g. "brightness_up_click"'),
  },
  commands: {},
  risk: 'low',
});

export const capabilities = {
  [OnOff.id]: OnOff,
  [LevelControl.id]: LevelControl,
  [ColorControl.id]: ColorControl,
  [TemperatureMeasurement.id]: TemperatureMeasurement,
  [RelativeHumidityMeasurement.id]: RelativeHumidityMeasurement,
  [IlluminanceMeasurement.id]: IlluminanceMeasurement,
  [OccupancySensing.id]: OccupancySensing,
  [BooleanState.id]: BooleanState,
  [PowerSource.id]: PowerSource,
  [ElectricalPowerMeasurement.id]: ElectricalPowerMeasurement,
  [WindowCovering.id]: WindowCovering,
  [Thermostat.id]: Thermostat,
  [FanControl.id]: FanControl,
  [DoorLock.id]: DoorLock,
  [GenericSwitch.id]: GenericSwitch,
} as const satisfies Record<string, CapabilityDefinition>;

export type CapabilityId = keyof typeof capabilities;

export function getCapability(id: string): CapabilityDefinition | undefined {
  return (capabilities as Record<string, CapabilityDefinition>)[id];
}
