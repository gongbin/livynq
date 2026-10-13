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
} as const satisfies Record<string, CapabilityDefinition>;

export type CapabilityId = keyof typeof capabilities;

export function getCapability(id: string): CapabilityDefinition | undefined {
  return (capabilities as Record<string, CapabilityDefinition>)[id];
}
