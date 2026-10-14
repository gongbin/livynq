import type { CapabilityId, Risk } from './capabilities.ts';

/** Home Assistant style entity domain, used for the entity view and HA compatibility. */
export type EntityDomain = 'light' | 'switch' | 'sensor' | 'binary_sensor' | 'cover' | 'climate' | 'fan' | 'lock' | 'event' | 'camera';

export interface DeviceTypeDefinition {
  id: string;
  /** Matter device type id. */
  matterDeviceType?: number;
  label: string;
  domain: EntityDomain;
  required: readonly CapabilityId[];
  optional: readonly CapabilityId[];
  /** Raises the risk of this device type's commands above its capabilities' (e.g. garage doors). */
  risk?: Risk;
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
  WindowCovering: define({ id: 'cover.window', matterDeviceType: 0x0202, label: 'Window Covering', domain: 'cover', required: ['windowCovering'], optional: [] }),
  GarageDoor: define({ id: 'cover.garage', label: 'Garage Door', domain: 'cover', required: ['windowCovering'], optional: [], risk: 'high' }),
  Gate: define({ id: 'cover.gate', label: 'Gate', domain: 'cover', required: ['windowCovering'], optional: [], risk: 'high' }),
  Thermostat: define({ id: 'climate.thermostat', matterDeviceType: 0x0301, label: 'Thermostat', domain: 'climate', required: ['thermostat'], optional: ['fanControl'] }),
  AirConditioner: define({ id: 'climate.airConditioner', matterDeviceType: 0x0072, label: 'Air Conditioner', domain: 'climate', required: ['thermostat'], optional: ['fanControl'] }),
  Fan: define({ id: 'fan.fan', matterDeviceType: 0x002b, label: 'Fan', domain: 'fan', required: ['onOff', 'fanControl'], optional: [] }),
  DoorLock: define({ id: 'lock.door', matterDeviceType: 0x000a, label: 'Door Lock', domain: 'lock', required: ['doorLock'], optional: [] }),
  Camera: define({ id: 'camera.camera', matterDeviceType: 0x0142, label: 'Camera', domain: 'camera', required: ['camera'], optional: ['occupancySensing'] }),
  VideoDoorbell: define({ id: 'camera.doorbell', matterDeviceType: 0x0143, label: 'Video Doorbell', domain: 'camera', required: ['camera', 'genericSwitch'], optional: ['occupancySensing'] }),
  GenericSwitch: define({ id: 'event.button', matterDeviceType: 0x000f, label: 'Button', domain: 'event', required: ['genericSwitch'], optional: [] }),
} as const satisfies Record<string, DeviceTypeDefinition>;

export type DeviceTypeId = (typeof DeviceTypes)[keyof typeof DeviceTypes]['id'];

const byId = new Map<string, DeviceTypeDefinition>(Object.values(DeviceTypes).map((d) => [d.id, d]));

export function getDeviceType(id: string): DeviceTypeDefinition | undefined {
  return byId.get(id);
}

export function listDeviceTypes(): DeviceTypeDefinition[] {
  return [...byId.values()];
}

const riskRank: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** Effective risk of commanding a capability on an endpoint of the given device type. */
export function commandRisk(capabilityRisk: Risk, deviceType: string): Risk {
  const typeRisk = getDeviceType(deviceType)?.risk;
  return typeRisk && riskRank[typeRisk] > riskRank[capabilityRisk] ? typeRisk : capabilityRisk;
}

export function riskAtMost(risk: Risk, limit: Risk): boolean {
  return riskRank[risk] <= riskRank[limit];
}
