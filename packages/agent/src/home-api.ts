import type { CommandBody, DeviceDTO, Room, SystemInfo } from '@livynq/model';
import { LivynqError, toDeviceDTO, type Home, type HistoryPoint } from '@livynq/core';
import type { AutomationEngine, AutomationInfo, Trace } from '@livynq/automation';

export interface DeviceFilter {
  q?: string;
  room?: string;
  domain?: string;
}

export interface HistoryQuery {
  endpoint?: number;
  capability: string;
  attribute: string;
  from: number;
  to: number;
}

/**
 * What agent tools need from a home. Implemented in-process (HTTP MCP endpoint)
 * and over REST (`livynq mcp` stdio bridge, CLI), so tools behave identically.
 */
export interface HomeApi {
  info(): Promise<SystemInfo>;
  rooms(): Promise<Room[]>;
  devices(filter?: DeviceFilter): Promise<DeviceDTO[]>;
  device(ref: string): Promise<DeviceDTO>;
  history(ref: string, query: HistoryQuery): Promise<HistoryPoint[]>;
  command(deviceId: string, endpointId: number, body: CommandBody, source: string): Promise<void>;
  automations(): Promise<AutomationInfo[]>;
  automationTraces(id: string): Promise<Trace[]>;
  /** Stores a disabled draft; never overwrites an existing automation. */
  proposeAutomation(config: Record<string, unknown>, source: string): Promise<AutomationInfo>;
}

export function createLocalHomeApi(home: Home, version = '0.0.0'): HomeApi {
  return {
    async info() {
      return {
        name: 'Livynq',
        version,
        startedAt: home.startedAt,
        adapters: home.adapters(),
        deviceCount: home.registry.listDevices().length,
        homekit: { enabled: Boolean(home.exporter('homekit')) },
        mcp: { path: '/mcp' },
      };
    },
    async rooms() {
      return home.registry.listRooms();
    },
    async devices(filter = {}) {
      return home.findDevices({ text: filter.q, room: filter.room, domain: filter.domain }).map((d) => toDeviceDTO(home, d));
    },
    async device(ref) {
      return toDeviceDTO(home, home.resolveTarget(ref).device);
    },
    async history(ref, query) {
      const target = home.resolveTarget(query.endpoint === undefined ? ref : `${home.resolveTarget(ref).device.id}#${query.endpoint}`, query.capability);
      return home.registry.history(target.device.id, target.endpointId, query.capability, query.attribute, query.from, query.to);
    },
    async command(deviceId, endpointId, body, source) {
      await home.command({ deviceId, endpointId, ...body }, source);
    },
    async automations() {
      return engine().list();
    },
    async automationTraces(id) {
      return engine().traces(id);
    },
    async proposeAutomation(config, source) {
      return engine().save(config, source, { onlyCreate: true, enabled: false });
    },
  };

  function engine(): AutomationEngine {
    const e = home.extension<AutomationEngine>('automations');
    if (!e) throw new LivynqError('NOT_SUPPORTED', 'Automations are disabled');
    return e;
  }
}
