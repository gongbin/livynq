import type { CapabilityId } from './capabilities.ts';

/** Home Assistant style entity domain, used for the entity view and HA compatibility. */
export type EntityDomain = 'light' | 'switch' | 'sensor' | 'binary_sensor';

export interface DeviceTypeDefinition {
  id: string;
  /** Matter device type id. */
  matterDeviceType?: number;
  label: string;
  domain: EntityDomain;
  required: readonly CapabilityId[];
  optional: readonly CapabilityId[];
}

function define<const D extends DeviceTypeDefinition>(d: D): D {
  return d;
}

export const DeviceTypes = {
  OnOffLight: define({ id: 'light.onOff', matterDeviceType: 0x0100, label: 'On/Off Light', domain: 'light', required: ['onOff'], optional: [] }),
  DimmableLight: define({ id: 'light.dimmable', matterDeviceType: 0x0101, label: 'Dimmable Light', domain: 'light', required: ['onOff', 'levelControl'], optional: [] }),
  ColorTemperatureLight: define({ id: 'light.colorTemperature', matterDeviceType: 0x010c, label: 'Color Temperature Light', domain: 'light', required: ['onOff', 'levelControl', 'colorControl'], optional: [] }),
  ExtendedColorLight: define({ id: 'light.extendedColor', matterDeviceType: 0x010d, label: 'Extended Color Light', domain: 'light', required: ['onOff', 'colorControl'], optional: ['levelControl'] }),
  OnOffPlugInUnit: define({ id: 'plug.onOff', matterDeviceType: 0x010a, label: 'Smart Plug', domain: 'switch', required: ['onOff'], optional: ['electricalPowerMeasurement'] }),
  OnOffSwitch: define({ id: 'switch.onOff', matterDeviceType: 0x0103, label: 'Switch', domain: 'switch', required: ['onOff'], optional: [] }),
  TemperatureSensor: define({ id: 'sensor.temperature', matterDeviceType: 0x0302, label: 'Temperature Sensor', domain: 'sensor', required: ['temperatureMeasurement'], optional: [] }),
  HumiditySensor: define({ id: 'sensor.humidity', matterDeviceType: 0x0307, label: 'Humidity Sensor', domain: 'sensor', required: ['relativeHumidityMeasurement'], optional: [] }),
  LightSensor: define({ id: 'sensor.light', matterDeviceType: 0x0106, label: 'Light Sensor', domain: 'sensor', required: ['illuminanceMeasurement'], optional: [] }),
  PowerSensor: define({ id: 'sensor.power', matterDeviceType: 0x0510, label: 'Power Sensor', domain: 'sensor', required: ['electricalPowerMeasurement'], optional: [] }),
  BatterySensor: define({ id: 'sensor.battery', matterDeviceType: 0x0011, label: 'Battery', domain: 'sensor', required: ['powerSource'], optional: [] }),
  OccupancySensor: define({ id: 'binarySensor.occupancy', matterDeviceType: 0x0107, label: 'Occupancy Sensor', domain: 'binary_sensor', required: ['occupancySensing'], optional: [] }),
  ContactSensor: define({ id: 'binarySensor.contact', matterDeviceType: 0x0015, label: 'Contact Sensor', domain: 'binary_sensor', required: ['booleanState'], optional: [] }),
  LeakSensor: define({ id: 'binarySensor.leak', matterDeviceType: 0x0043, label: 'Water Leak Detector', domain: 'binary_sensor', required: ['booleanState'], optional: [] }),
} as const satisfies Record<string, DeviceTypeDefinition>;

export type DeviceTypeId = (typeof DeviceTypes)[keyof typeof DeviceTypes]['id'];

const byId = new Map<string, DeviceTypeDefinition>(Object.values(DeviceTypes).map((d) => [d.id, d]));

export function getDeviceType(id: string): DeviceTypeDefinition | undefined {
  return byId.get(id);
}

export function listDeviceTypes(): DeviceTypeDefinition[] {
  return [...byId.values()];
}
