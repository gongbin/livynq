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
  type TokenScope,
} from '@livynq/model';
import type { HomeApi } from './home-api.ts';
import { describeCommands, endpointForTarget, summarizeDevice } from './describe.ts';

export interface McpOptions {
  api: HomeApi;
  scope: TokenScope;
  /** Recorded as the command source, e.g. `agent:claude-desktop`. */
  clientName: string;
  version: string;
}

class ToolError extends Error {}

const INSTRUCTIONS = `Livynq is a local smart home hub. Start with home_overview, then list_devices to find targets.
Targets accept an entity id (light.living_room_ceiling), a device id (zigbee:0x...), a device name or alias.
Prefer the high-level actions of control_device (turn_on, set_brightness...). Devices marked readOnly cannot be controlled.
Every command is recorded in the audit log with this client's name.`;

export const actions = ['turn_on', 'turn_off', 'toggle', 'set_brightness', 'set_color_temperature', 'set_color', 'raw'] as const;
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

const controlTool: Tool = {
  name: 'control_device',
  description:
    'Control a device. Use a high-level action, or action "raw" with capability/command/params from get_device. ' +
    'brightness is 0-100 %, colorTemperature in Kelvin, hue in degrees (0-360), saturation 0-100 %.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Entity id, device id, name or alias' },
      action: { type: 'string', enum: [...actions] },
      brightness: { type: 'number', minimum: 0, maximum: 100 },
      colorTemperature: { type: 'number', minimum: 1000, maximum: 20000 },
      hue: { type: 'number', minimum: 0, maximum: 360 },
      saturation: { type: 'number', minimum: 0, maximum: 100 },
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: canControl ? [...readTools, controlTool] : readTools }));

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
          const body = actionToCommand(requireStr(args.action, 'action') as Action, args);
          const endpointId = endpointForTarget(device, target, body.capability);
          await api.command(device.id, endpointId, body, `agent:${options.clientName}`).catch((err: Error) => {
            throw new ToolError(err.message);
          });
          return json({ ok: true, device: device.name, endpointId, sent: body, note: 'State updates once the device confirms; call get_device to verify.' });
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
