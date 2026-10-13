import {
  getCapability,
  getDeviceType,
  levelToPercent,
  hueToDegrees,
  satToPercent,
  miredsToKelvin,
  type AttributeValue,
  type DeviceDTO,
  type ValueSchema,
} from '@livynq/model';

/** Compact, LLM-friendly view of a device: fewer tokens, human units, entity ids first. */
export interface DeviceSummary {
  id: string;
  name: string;
  room: string | null;
  aliases?: string[];
  availability: string;
  agentAccess: 'visible' | 'readOnly';
  endpoints: {
    endpointId: number;
    entityId?: string;
    type: string;
    name?: string;
    state: Record<string, AttributeValue | string>;
  }[];
}

export function summarizeDevice(device: DeviceDTO): DeviceSummary {
  return {
    id: device.id,
    name: device.name,
    room: device.roomName,
    ...(device.aliases.length ? { aliases: device.aliases } : {}),
    availability: device.availability,
    agentAccess: device.exposure.agent === 'readOnly' ? 'readOnly' : 'visible',
    endpoints: device.endpoints.map((ep) => ({
      endpointId: ep.id,
      entityId: device.entities[ep.id],
      type: getDeviceType(ep.deviceType)?.label ?? ep.deviceType,
      ...(ep.name ? { name: ep.name } : {}),
      state: humanState(device.state[ep.id] ?? {}),
    })),
  };
}

function humanState(state: Record<string, Record<string, AttributeValue>>): Record<string, AttributeValue | string> {
  const out: Record<string, AttributeValue | string> = {};
  for (const [cap, attrs] of Object.entries(state)) {
    for (const [attr, value] of Object.entries(attrs)) {
      if (value === null) continue;
      const key = `${cap}.${attr}`;
      switch (key) {
        case 'onOff.onOff':
          out.on = value;
          break;
        case 'levelControl.currentLevel':
          out.brightnessPercent = levelToPercent(Number(value));
          break;
        case 'colorControl.colorTemperatureMireds':
          out.colorTemperatureKelvin = miredsToKelvin(Number(value));
          break;
        case 'colorControl.currentHue':
          out.hueDegrees = hueToDegrees(Number(value));
          break;
        case 'colorControl.currentSaturation':
          out.saturationPercent = satToPercent(Number(value));
          break;
        case 'colorControl.colorMode':
          out.colorMode = value;
          break;
        case 'colorControl.colorTempPhysicalMinMireds':
        case 'colorControl.colorTempPhysicalMaxMireds':
          break;
        case 'temperatureMeasurement.measuredValue':
          out.temperatureCelsius = value;
          break;
        case 'relativeHumidityMeasurement.measuredValue':
          out.humidityPercent = value;
          break;
        case 'illuminanceMeasurement.measuredValue':
          out.illuminanceLux = value;
          break;
        case 'occupancySensing.occupied':
          out.occupied = value;
          break;
        case 'booleanState.stateValue':
          out.contactClosed = value;
          break;
        case 'powerSource.batPercentRemaining':
          out.batteryPercent = value;
          break;
        case 'electricalPowerMeasurement.activePower':
          out.powerWatts = value;
          break;
        case 'windowCovering.currentPosition':
          out.positionPercent = value;
          break;
        case 'windowCovering.targetPosition':
        case 'thermostat.minSetpoint':
        case 'thermostat.maxSetpoint':
        case 'genericSwitch.lastEventAt':
          break;
        case 'windowCovering.operationalStatus':
          if (value !== 'stopped') out.moving = value;
          break;
        case 'thermostat.localTemperature':
          out.currentTemperatureCelsius = value;
          break;
        case 'thermostat.targetTemperature':
          out.targetTemperatureCelsius = value;
          break;
        case 'thermostat.systemMode':
          out.mode = value;
          break;
        case 'thermostat.supportedModes':
          out.supportedModes = value;
          break;
        case 'thermostat.runningState':
          out.running = value;
          break;
        case 'fanControl.percentCurrent':
          out.fanSpeedPercent = value;
          break;
        case 'fanControl.fanMode':
          out.fanMode = value;
          break;
        case 'doorLock.lockState':
          out.lock = value;
          break;
        case 'genericSwitch.lastEvent':
          out.lastPress = attrs.lastEventAt ? `${value} at ${new Date(Number(attrs.lastEventAt)).toISOString()}` : value;
          break;
        default:
          out[key] = value;
      }
    }
  }
  return out;
}

/** Commands an agent may call on a device, with parameter schemas. */
export function describeCommands(device: DeviceDTO): { endpointId: number; capability: string; command: string; params: ValueSchema }[] {
  const out: { endpointId: number; capability: string; command: string; params: ValueSchema }[] = [];
  for (const ep of device.endpoints) {
    for (const capId of ep.capabilities) {
      const cap = getCapability(capId);
      for (const [command, params] of Object.entries(cap?.commands ?? {})) out.push({ endpointId: ep.id, capability: capId, command, params });
    }
  }
  return out;
}

/** Entity ids pin an endpoint, "#n" suffixes too; otherwise the first endpoint with the capability is used. */
export function endpointForTarget(device: DeviceDTO, target: string, capability: string): number {
  const pinned = Object.entries(device.entities).find(([, entityId]) => entityId === target);
  if (pinned) {
    const ep = device.endpoints.find((e) => e.id === Number(pinned[0]))!;
    if (!ep.capabilities.includes(capability as never)) throw new Error(`${target} does not support ${capability}`);
    return ep.id;
  }
  const hash = target.match(/#(\d+)$/);
  if (hash) return Number(hash[1]);
  const ep = device.endpoints.find((e) => e.capabilities.includes(capability as never));
  if (!ep) throw new Error(`${device.name} does not support ${capability}`);
  return ep.id;
}
