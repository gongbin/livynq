import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  degreesToHue,
  kelvinToMireds,
  percentToLevel,
  percentToSat,
  type CommandBody,
  type DeviceDTO,
  type Risk,
  type TokenScope,
} from '@livynq/model';
import type { HomeApi } from './home-api.ts';
import { describeCommands, endpointForTarget, summarizeDevice } from './describe.ts';
import { polygonArea } from '@livynq/core';

export interface McpOptions {
  api: HomeApi;
  scope: TokenScope;
  /** The token's risk limit: actions above it are queued for human approval. */
  riskLimit: Risk;
  /** Recorded as the command source, e.g. `agent:claude-desktop`. */
  clientName: string;
  version: string;
}

class ToolError extends Error {}

const INSTRUCTIONS = `Livynq is a local smart home hub. Start with home_overview, then list_devices to find targets.
Targets accept an entity id (light.living_room_ceiling), a device id (zigbee:0x...), a device name or alias.
Prefer the high-level actions of control_device (turn_on, set_brightness...). Devices marked readOnly cannot be controlled.
Every command is recorded in the audit log with this client's name.
Risky actions (unlocking doors, garage doors, anything above this token's risk limit) are not executed immediately:
they wait for the user's approval in Livynq. Never try to work around a pending confirmation.`;

export const actions = [
  'turn_on',
  'turn_off',
  'toggle',
  'set_brightness',
  'set_color_temperature',
  'set_color',
  'open',
  'close',
  'stop',
  'set_position',
  'set_temperature',
  'set_hvac_mode',
  'set_fan_speed',
  'lock',
  'unlock',
  'raw',
] as const;
export type Action = (typeof actions)[number];

const readTools: Tool[] = [
  {
    name: 'home_overview',
    description: 'Summary of the home: rooms, device counts by room, offline devices and lights currently on.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, title: 'Home overview' },
  },
  {
    name: 'list_devices',
    description: 'List devices with their current state in human units. Filter by room, entity domain or free text (name, alias, entity id).',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room name, alias or id' },
        domain: { type: 'string', enum: ['light', 'switch', 'sensor', 'binary_sensor'] },
        query: { type: 'string', description: 'Free text matched against name, aliases, entity ids, room' },
      },
    },
    annotations: { readOnlyHint: true, title: 'List devices' },
  },
  {
    name: 'get_device',
    description: 'Full state of one device and the commands it accepts (with parameter schemas).',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'Entity id, device id, name or alias' } }, required: ['target'] },
    annotations: { readOnlyHint: true, title: 'Get device' },
  },
  {
    name: 'get_history',
    description: 'Recorded values of one attribute (e.g. temperatureMeasurement.measuredValue) over the last N hours, downsampled to at most 60 points.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        attribute: { type: 'string', description: 'capability.attribute, e.g. onOff.onOff or temperatureMeasurement.measuredValue' },
        hours: { type: 'number', minimum: 1, maximum: 720, default: 24 },
      },
      required: ['target', 'attribute'],
    },
    annotations: { readOnlyHint: true, title: 'Attribute history' },
  },
];

readTools.push(
  {
    name: 'get_floorplan',
    description:
      'The home as space: floors, rooms (area in m², which rooms share a wall), and where devices are (x/y in meters on the floor). ' +
      'Use it for requests like "lights in the rooms next to the kitchen" or "the lamp nearest the sofa".',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, title: 'Floor plan' },
  },
  {
    name: 'list_automations',
    description: 'List automations with enabled state, validity, last trigger time and who created them.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, title: 'List automations' },
  },
  {
    name: 'get_automation',
    description: 'One automation: its Home Assistant style config and its most recent run traces (trigger, condition results, steps, errors). Use it to explain or debug behaviour.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, traces: { type: 'number', minimum: 0, maximum: 20, default: 3 } }, required: ['id'] },
    annotations: { readOnlyHint: true, title: 'Get automation' },
  },
);

const confirmationTool: Tool = {
  name: 'get_confirmation',
  description: 'Status of an action that was queued for the user to approve (pending, executed, denied, expired, failed).',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  annotations: { readOnlyHint: true, title: 'Confirmation status' },
};

const proposeTool: Tool = {
  name: 'propose_automation',
  description:
    'Save a NEW automation as a disabled draft for the user to review and enable. Use Home Assistant automation syntax: ' +
    '{ alias, description?, mode?, triggers: [{trigger: state|numeric_state|time|time_pattern|sun|homeassistant|webhook, ...}], ' +
    'conditions?: [{condition: state|numeric_state|time|sun|and|or|not|trigger, ...}], ' +
    'actions: [{action: light.turn_on|light.turn_off|light.toggle|switch.*|homeassistant.*|automation.*, target: {entity_id|area_id}, data?} | {delay} | {wait_for_trigger} | {choose} | {if/then/else} | {repeat} | {parallel} | {stop}] }. ' +
    'Templates are not supported. Invalid configs return precise errors to fix. Existing automations are never overwritten.',
  inputSchema: { type: 'object', properties: { automation: { type: 'object', description: 'The automation config' } }, required: ['automation'] },
  annotations: { readOnlyHint: false, destructiveHint: false, title: 'Propose automation' },
};

const controlTool: Tool = {
  name: 'control_device',
  description:
    'Control a device. Use a high-level action, or action "raw" with capability/command/params from get_device. ' +
    'brightness is 0-100 %, colorTemperature in Kelvin, hue in degrees (0-360), saturation 0-100 %, position 0-100 % (100 = open), ' +
    'temperature in °C, mode one of off/heat/cool/auto/dry/fan_only, percent = fan speed 0-100. ' +
    'High-risk actions (unlock, garage doors) or anything above this token\'s risk limit are queued for the user to approve: ' +
    'the result then says "pending_confirmation"; tell the user and check later with get_confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Entity id, device id, name or alias' },
      action: { type: 'string', enum: [...actions] },
      brightness: { type: 'number', minimum: 0, maximum: 100 },
      colorTemperature: { type: 'number', minimum: 1000, maximum: 20000 },
      hue: { type: 'number', minimum: 0, maximum: 360 },
      saturation: { type: 'number', minimum: 0, maximum: 100 },
      position: { type: 'number', minimum: 0, maximum: 100 },
      temperature: { type: 'number', minimum: 5, maximum: 35 },
      mode: { type: 'string', enum: ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'] },
      percent: { type: 'number', minimum: 0, maximum: 100 },
      capability: { type: 'string' },
      command: { type: 'string' },
      params: { type: 'object' },
    },
    required: ['target', 'action'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, title: 'Control device' },
};

export function createMcpServer(options: McpOptions): Server {
  const { api, scope } = options;
  const canControl = scope === 'control' || scope === 'admin';
  const server = new Server({ name: 'livynq', version: options.version }, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });

  const visible = (devices: DeviceDTO[]) => devices.filter((d) => d.exposure.agent !== 'hidden');
  const findDevice = async (target: string): Promise<DeviceDTO> => {
    const device = await api.device(target).catch((err: Error) => {
      throw new ToolError(err.message);
    });
    if (device.exposure.agent === 'hidden') throw new ToolError(`No device or entity matches "${target}"`);
    return device;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: canControl ? [...readTools, controlTool, confirmationTool, proposeTool] : readTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case 'home_overview': {
          const [info, rooms, devices] = await Promise.all([api.info(), api.rooms(), api.devices()]);
          const shown = visible(devices);
          const byRoom = new Map<string, number>();
          for (const d of shown) byRoom.set(d.roomName ?? '(no room)', (byRoom.get(d.roomName ?? '(no room)') ?? 0) + 1);
          return json({
            version: info.version,
            rooms: rooms.map((r) => ({ name: r.name, aliases: r.aliases, devices: byRoom.get(r.name) ?? 0 })),
            devicesWithoutRoom: byRoom.get('(no room)') ?? 0,
            deviceCount: shown.length,
            offline: shown.filter((d) => d.availability === 'offline').map((d) => d.name),
            lightsOn: shown
              .filter((d) => d.endpoints.some((ep) => ep.deviceType.startsWith('light.') && d.state[ep.id]?.onOff?.onOff === true))
              .map((d) => `${d.name}${d.roomName ? ` (${d.roomName})` : ''}`),
            canControl,
          });
        }
        case 'list_devices': {
          const devices = await api.devices({ room: str(args.room), domain: str(args.domain), q: str(args.query) });
          return json(visible(devices).map(summarizeDevice));
        }
        case 'get_device': {
          const device = await findDevice(requireStr(args.target, 'target'));
          return json({ ...summarizeDevice(device), info: device.info, commands: device.exposure.agent === 'readOnly' || !canControl ? [] : describeCommands(device) });
        }
        case 'get_history': {
          const device = await findDevice(requireStr(args.target, 'target'));
          const [capability, attribute] = requireStr(args.attribute, 'attribute').split('.');
          if (!capability || !attribute) throw new ToolError('attribute must look like capability.attribute');
          const hours = Math.min(720, Math.max(1, Number(args.hours ?? 24)));
          const to = Date.now();
          const ref = endpointForTarget(device, requireStr(args.target, 'target'), capability);
          const points = await api.history(device.id, { endpoint: ref, capability, attribute, from: to - hours * 3600_000, to });
          return json({ device: device.name, attribute: `${capability}.${attribute}`, points: downsample(points, 60).map((p) => [new Date(p.ts).toISOString(), p.value]) });
        }
        case 'control_device': {
          if (!canControl) throw new ToolError('This token is read-only; ask the user for a token with "control" scope.');
          const target = requireStr(args.target, 'target');
          const device = await findDevice(target);
          if (device.exposure.agent === 'readOnly') throw new ToolError(`${device.name} is read-only for agents. Ask the user to control it.`);
          if (device.availability === 'offline') throw new ToolError(`${device.name} is offline.`);
          let body = actionToCommand(requireStr(args.action, 'action') as Action, args);
          const hasCapability = (cap: string) => device.endpoints.some((e) => e.capabilities.includes(cap as never));
          // "turn on/off the AC": thermostats have modes, not an on/off switch.
          if (body.capability === 'onOff' && !hasCapability('onOff') && hasCapability('thermostat')) {
            body = { capability: 'thermostat', command: 'setSystemMode', params: { mode: body.command === 'off' ? 'off' : 'auto' } };
          }
          const endpointId = endpointForTarget(device, target, body.capability);
          const outcome = await api.command(device.id, endpointId, body, `agent:${options.clientName}`, options.riskLimit).catch((err: Error) => {
            throw new ToolError(err.message);
          });
          if (outcome.status === 'pending') {
            return json({
              ok: false,
              pending_confirmation: outcome.confirmation.id,
              summary: outcome.confirmation.summary,
              risk: outcome.confirmation.risk,
              note: 'Not executed yet: the user must approve this in the Livynq app (expires in 5 minutes). Tell the user, then check with get_confirmation.',
            });
          }
          return json({ ok: true, device: device.name, endpointId, sent: body, note: 'State updates once the device confirms; call get_device to verify.' });
        }
        case 'get_confirmation': {
          const c = await api.confirmation(requireStr(args.id, 'id'));
          return json({ id: c.id, status: c.status, summary: c.summary, decidedBy: c.decidedBy, error: c.error });
        }
        case 'get_floorplan': {
          const [plan, devices] = await Promise.all([api.floorplan(), api.devices()]);
          const shown = visible(devices);
          const roomName = new Map(plan.rooms.map((r) => [r.id, r.name]));
          const placed = new Map(plan.placements.map((p) => [p.deviceId, p.placement]));
          const devicesIn = (roomId: string) =>
            shown
              .filter((d) => d.roomId === roomId)
              .map((d) => {
                const p = placed.get(d.id);
                return { name: d.name, entityIds: Object.values(d.entities), ...(p ? { position: [round(p.x), round(p.y)], ...(p.mount ? { mount: p.mount } : {}) } : {}) };
              });
          return json({
            units: 'meters',
            levels: plan.levels.map((l) => ({
              name: l.name,
              elevation: l.elevation,
              rooms: plan.rooms
                .filter((r) => r.levelId === l.id)
                .map((r) => ({
                  name: r.name,
                  ...(r.polygon ? { areaM2: round(polygonArea(r.polygon)), outline: r.polygon.map(([x, y]) => [round(x), round(y)]) } : {}),
                  adjacentTo: (plan.adjacency[r.id] ?? []).map((id) => roomName.get(id)),
                  devices: devicesIn(r.id),
                })),
            })),
            roomsWithoutFloor: plan.rooms.filter((r) => !r.levelId).map((r) => ({ name: r.name, devices: devicesIn(r.id) })),
          });
        }
        case 'list_automations':
          return json(
            (await api.automations()).map((a) => ({
              id: a.id,
              alias: a.alias,
              enabled: a.enabled,
              valid: a.valid,
              ...(a.valid ? {} : { errors: a.errors }),
              lastTriggered: a.lastTriggered ? new Date(a.lastTriggered).toISOString() : null,
              createdBy: a.createdBy,
            })),
          );
        case 'get_automation': {
          const id = requireStr(args.id, 'id');
          const info = (await api.automations()).find((a) => a.id === id);
          if (!info) throw new ToolError(`Automation not found: ${id}`);
          const count = Math.min(20, Math.max(0, Number(args.traces ?? 3)));
          const traces = (await api.automationTraces(id)).slice(0, count).map((t) => ({
            started: new Date(t.startedAt).toISOString(),
            state: t.state,
            trigger: t.trigger.description,
            ...(t.stopReason ? { stopReason: t.stopReason } : {}),
            ...(t.error ? { error: t.error } : {}),
            conditions: t.conditions,
            steps: t.steps.map((s) => ({ path: s.path, type: s.type, ...(s.error ? { error: s.error } : {}) })),
          }));
          return json({ id: info.id, alias: info.alias, enabled: info.enabled, valid: info.valid, errors: info.errors, config: info.config, traces });
        }
        case 'propose_automation': {
          if (!canControl) throw new ToolError('This token is read-only; proposing automations needs "control" scope.');
          const config = args.automation;
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ToolError('automation must be an object');
          const info = await api.proposeAutomation(config as Record<string, unknown>, `agent:${options.clientName}`);
          return json({ ok: true, id: info.id, enabled: false, note: 'Saved as a disabled draft. Ask the user to review and enable it in Livynq.' });
        }
        default:
          throw new ToolError(`Unknown tool ${request.params.name}`);
      }
    } catch (err) {
      // Tool failures are reported to the model as results so it can recover (wrong target, offline...).
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'livynq://rooms', name: 'Rooms', mimeType: 'application/json' },
      { uri: 'livynq://devices', name: 'Devices', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const data = uri === 'livynq://rooms' ? await api.rooms() : uri === 'livynq://devices' ? visible(await api.devices()).map(summarizeDevice) : undefined;
    if (data === undefined) throw new Error(`Unknown resource ${uri}`);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  });

  return server;
}

/** Stateless Streamable HTTP: a fresh server per request keeps the endpoint horizontally trivial. */
export async function handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse, body: unknown, options: McpOptions): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }).end(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }),
    );
    return;
  }
  const server = createMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ------------------------------------------------------------------ helpers

export function actionToCommand(action: Action, args: Record<string, unknown>): CommandBody {
  const num = (key: string) => {
    const v = args[key];
    if (typeof v !== 'number' || Number.isNaN(v)) throw new ToolError(`${key} (number) is required for ${action}`);
    return v;
  };
  switch (action) {
    case 'turn_on':
      return { capability: 'onOff', command: 'on' };
    case 'turn_off':
      return { capability: 'onOff', command: 'off' };
    case 'toggle':
      return { capability: 'onOff', command: 'toggle' };
    case 'set_brightness': {
      const pct = num('brightness');
      return pct <= 0 ? { capability: 'onOff', command: 'off' } : { capability: 'levelControl', command: 'moveToLevel', params: { level: percentToLevel(pct) } };
    }
    case 'set_color_temperature':
      return { capability: 'colorControl', command: 'moveToColorTemperature', params: { colorTemperatureMireds: kelvinToMireds(num('colorTemperature')) } };
    case 'set_color':
      return { capability: 'colorControl', command: 'moveToHueAndSaturation', params: { hue: degreesToHue(num('hue')), saturation: percentToSat(num('saturation')) } };
    case 'open':
      return { capability: 'windowCovering', command: 'open' };
    case 'close':
      return { capability: 'windowCovering', command: 'close' };
    case 'stop':
      return { capability: 'windowCovering', command: 'stop' };
    case 'set_position':
      return { capability: 'windowCovering', command: 'goToPosition', params: { position: Math.round(num('position')) } };
    case 'set_temperature':
      return { capability: 'thermostat', command: 'setTargetTemperature', params: { temperature: num('temperature') } };
    case 'set_hvac_mode':
      return { capability: 'thermostat', command: 'setSystemMode', params: { mode: requireStr(args.mode, 'mode') } };
    case 'set_fan_speed': {
      const percent = Math.round(num('percent'));
      return percent <= 0 ? { capability: 'onOff', command: 'off' } : { capability: 'fanControl', command: 'setPercent', params: { percent } };
    }
    case 'lock':
      return { capability: 'doorLock', command: 'lock' };
    case 'unlock':
      return { capability: 'doorLock', command: 'unlock' };
    case 'raw':
      return {
        capability: requireStr(args.capability, 'capability'),
        command: requireStr(args.command, 'command'),
        params: (args.params as Record<string, unknown> | undefined) ?? {},
      };
    default:
      throw new ToolError(`Unknown action ${String(action)}; use one of ${actions.join(', ')}`);
  }
}

function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.floor(i * step)]!).concat(points.at(-1)!);
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function requireStr(v: unknown, name: string): string {
  const s = str(v);
  if (!s) throw new ToolError(`${name} is required`);
  return s;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
