import type { CommandBody, ConfirmationDTO, DeviceDTO, Risk, Room, SystemInfo } from '@livynq/model';
import { LivynqError, toDeviceDTO, type FloorPlan, type Home, type HistoryPoint } from '@livynq/core';
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
export type CommandOutcome = { status: 'executed' } | { status: 'pending'; confirmation: ConfirmationDTO };

export interface HomeApi {
  info(): Promise<SystemInfo>;
  rooms(): Promise<Room[]>;
  devices(filter?: DeviceFilter): Promise<DeviceDTO[]>;
  device(ref: string): Promise<DeviceDTO>;
  history(ref: string, query: HistoryQuery): Promise<HistoryPoint[]>;
  /** Runs the command, or queues it for human approval when it exceeds the caller's risk limit. */
  command(deviceId: string, endpointId: number, body: CommandBody, source: string, riskLimit: Risk): Promise<CommandOutcome>;
  confirmation(id: string): Promise<ConfirmationDTO>;
  floorplan(): Promise<FloorPlan & { adjacency: Record<string, string[]> }>;
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
    async command(deviceId, endpointId, body, source, riskLimit) {
      const result = await home.confirmations.guard({ deviceId, endpointId, ...body }, { source, riskLimit });
      return result.status === 'pending' ? { status: 'pending', confirmation: result.confirmation } : { status: 'executed' };
    },
    async confirmation(id) {
      return home.confirmations.get(id);
    },
    async floorplan() {
      return { ...home.spaces.floorPlan(), adjacency: home.spaces.adjacency() };
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
