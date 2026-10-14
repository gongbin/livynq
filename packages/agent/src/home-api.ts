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
  command(deviceId: string, endpointId: number, body: CommandBody, source: string, riskLimit: Risk, options?: { canRequestApproval?: boolean }): Promise<CommandOutcome>;
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
    async command(deviceId, endpointId, body, source, riskLimit, options) {
      const result = await home.confirmations.guard({ deviceId, endpointId, ...body }, { source, riskLimit, ...(options?.canRequestApproval === false ? { canRequestApproval: false } : {}) });
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

/**
 * The same home seen by a restricted user: only devices in `rooms` (unassigned devices hidden),
 * no automations for guests, and over-limit commands refused when approval can't be requested.
 */
export function restrictHomeApi(api: HomeApi, access: { rooms: Set<string> | null; automations: boolean; canRequestApproval: boolean }): HomeApi {
  if (access.rooms === null && access.automations && access.canRequestApproval) return api;
  const rooms = access.rooms;
  const visible = (d: { roomId?: string | null }) => rooms === null || (d.roomId != null && rooms.has(d.roomId));
  const notFound = (ref: string) => new LivynqError('NOT_FOUND', `No device or entity matches "${ref}"`);
  const device = async (ref: string) => {
    const d = await api.device(ref).catch(() => undefined);
    if (!d || !visible(d)) throw notFound(ref);
    return d;
  };
  const noAutomations = () => new LivynqError('FORBIDDEN', 'This account cannot see automations');
  return {
    ...api,
    async rooms() {
      return (await api.rooms()).filter((r) => rooms === null || rooms.has(r.id));
    },
    async devices(filter) {
      return (await api.devices(filter)).filter(visible);
    },
    device,
    async history(ref, query) {
      await device(ref);
      return api.history(ref, query);
    },
    async command(deviceId, endpointId, body, source, riskLimit, options) {
      await device(deviceId);
      return api.command(deviceId, endpointId, body, source, riskLimit, access.canRequestApproval ? options : { ...options, canRequestApproval: false });
    },
    async floorplan() {
      const plan = await api.floorplan();
      if (rooms === null) return plan;
      const keptRooms = plan.rooms.filter((r) => rooms.has(r.id));
      const levels = new Set(keptRooms.map((r) => r.levelId));
      const shown = new Set((await api.devices()).filter(visible).map((d) => d.id));
      return {
        ...plan,
        levels: plan.levels.filter((l) => levels.has(l.id)),
        rooms: keptRooms,
        placements: plan.placements.filter((p) => shown.has(p.deviceId)),
        adjacency: Object.fromEntries(Object.entries(plan.adjacency).filter(([id]) => rooms.has(id)).map(([id, adj]) => [id, adj.filter((a) => rooms.has(a))])),
      };
    },
    async automations() {
      if (!access.automations) return [];
      return api.automations();
    },
    async automationTraces(id) {
      if (!access.automations) throw noAutomations();
      return api.automationTraces(id);
    },
    async proposeAutomation(config, source) {
      if (!access.automations) throw noAutomations();
      return api.proposeAutomation(config, source);
    },
  };
}
