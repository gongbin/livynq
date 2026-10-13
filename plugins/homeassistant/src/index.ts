import { defineAdapter, getCapability, type PluginContext, type PluginDevice } from '@livynq/sdk';
import { HaClient } from './client.ts';
import { commandToService, planEntity, stateToUpdates, SUPPORTED_DOMAINS, type EndpointPlan, type HaState } from './mapping.ts';

/**
 * Live bridge to a running Home Assistant: its entities appear in Livynq (Apple Home, Matter,
 * automations, agents, 3D) while Home Assistant keeps running the integrations Livynq lacks.
 *
 *   plugins:
 *     - module: "@livynq/plugin-homeassistant"
 *       config:
 *         url: http://homeassistant.local:8123
 *         token: !secret ha_token          # long-lived access token (HA profile → Security)
 *         include: ["light.*", "climate.living_room"]   # optional globs
 *         exclude: ["sensor.*_battery"]                 # optional globs
 *
 * Inside the Livynq Home Assistant add-on, url/token default to the Supervisor proxy.
 * Devices Livynq already integrates directly (e.g. the same Zigbee2MQTT device) are skipped.
 */
interface Registries {
  areas: Map<string, string>;
  devices: Map<string, { name: string; originalName?: string; manufacturer?: string; model?: string; area_id?: string | null; identifiers: [string, string][] }>;
  entities: Map<string, { device_id: string | null; area_id: string | null; disabled_by: string | null; platform: string }>;
}

interface Bound {
  device: PluginDevice;
  endpoints: Map<string, { endpointId: number; plan: EndpointPlan }>;
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export default defineAdapter({
  async setup(ctx) {
    const url = (ctx.config.url as string | undefined) ?? (process.env.SUPERVISOR_TOKEN ? 'http://supervisor/core' : undefined);
    const token = (ctx.config.token as string | undefined) ?? process.env.SUPERVISOR_TOKEN;
    if (!url || !token) throw new Error('config.url and config.token (a Home Assistant long-lived access token) are required');
    const include = (Array.isArray(ctx.config.include) ? (ctx.config.include as string[]) : []).map(glob);
    const exclude = (Array.isArray(ctx.config.exclude) ? (ctx.config.exclude as string[]) : []).map(glob);
    const wanted = (entityId: string) => SUPPORTED_DOMAINS.includes(entityId.split('.')[0]!) && (!include.length || include.some((r) => r.test(entityId))) && !exclude.some((r) => r.test(entityId));

    const bound = new Map<string, Bound>();
    const entityToDevice = new Map<string, string>();
    const states = new Map<string, HaState>();

    const refreshAvailability = (id: string) => {
      const b = bound.get(id);
      if (!b) return;
      const all = [...b.endpoints.keys()].map((e) => states.get(e)?.state);
      b.device.setAvailability(client.connected && all.some((s) => s !== undefined && s !== 'unavailable') ? 'online' : 'offline');
    };

    const client: HaClient = new HaClient({
      url,
      token,
      log: (m) => ctx.log.info(m),
      onDisconnected: (reason) => {
        ctx.log.warn(`Home Assistant disconnected (${reason}); retrying`);
        for (const b of bound.values()) b.device.setAvailability('offline');
      },
      onEvent: (event) => {
        if (event.event_type !== 'state_changed') return;
        const entityId = String(event.data.entity_id);
        const newState = event.data.new_state as HaState | null;
        const deviceId = entityToDevice.get(entityId);
        if (!deviceId || !newState) return;
        states.set(entityId, newState);
        const b = bound.get(deviceId)!;
        const ep = b.endpoints.get(entityId)!;
        for (const u of stateToUpdates(ep.plan, newState)) b.device.update(ep.endpointId, u.capability, u.attributes);
        refreshAvailability(deviceId);
      },
      onConnected: async () => {
        const [areas, devices, entities, allStates] = await Promise.all([
          client.send<{ area_id: string; name: string }[]>({ type: 'config/area_registry/list' }),
          client.send<{ id: string; name: string | null; name_by_user: string | null; manufacturer: string | null; model: string | null; area_id: string | null; identifiers: [string, string][] }[]>({ type: 'config/device_registry/list' }),
          client.send<{ entity_id: string; device_id: string | null; area_id: string | null; disabled_by: string | null; platform: string }[]>({ type: 'config/entity_registry/list' }),
          client.send<HaState[]>({ type: 'get_states' }),
        ]);
        const reg: Registries = {
          areas: new Map(areas.map((a) => [a.area_id, a.name])),
          devices: new Map(devices.map((d) => [d.id, { name: d.name_by_user ?? d.name ?? d.id, originalName: d.name ?? undefined, manufacturer: d.manufacturer ?? undefined, model: d.model ?? undefined, area_id: d.area_id, identifiers: d.identifiers }])),
          entities: new Map(entities.map((e) => [e.entity_id, e])),
        };
        await sync(ctx, reg, allStates);
        await client.send({ type: 'subscribe_events', event_type: 'state_changed' });
      },
    });

    async function sync(ctx: PluginContext, reg: Registries, allStates: HaState[]): Promise<void> {
      const groups = new Map<string, { name: string; prefixes: string[]; room?: string; manufacturer?: string; model?: string; states: HaState[] }>();
      let skipped = 0;
      for (const s of allStates) {
        const entry = reg.entities.get(s.entity_id);
        if (entry?.disabled_by || !wanted(s.entity_id) || !planEntity(s)) continue;
        const haDevice = entry?.device_id ? reg.devices.get(entry.device_id) : undefined;
        // Already integrated directly by Livynq (e.g. the same MQTT device): don't duplicate it.
        const mqttId = haDevice?.identifiers.find(([d]) => d === 'mqtt')?.[1];
        if (mqttId && (await ctx.devices.exists(`mqtt:${mqttId.replace(/[^A-Za-z0-9_.:-]/g, '_')}`))) {
          skipped++;
          continue;
        }
        const key = entry?.device_id ? `ha:${entry.device_id}` : `ha:${s.entity_id}`;
        const area = entry?.area_id ?? haDevice?.area_id ?? undefined;
        const group = groups.get(key) ?? {
          name: haDevice?.name ?? String(s.attributes.friendly_name ?? s.entity_id),
          prefixes: [haDevice?.name, haDevice?.originalName].filter((x): x is string => Boolean(x)),
          room: area ? reg.areas.get(area) : undefined,
          manufacturer: haDevice?.manufacturer,
          model: haDevice?.model,
          states: [],
        };
        group.states.push(s);
        groups.set(key, group);
      }
      for (const [id, g] of groups) {
        const endpoints = new Map<string, { endpointId: number; plan: EndpointPlan }>();
        for (const s of g.states) endpoints.set(s.entity_id, { endpointId: await ctx.endpointId(id, s.entity_id), plan: planEntity(s)! });
        const multi = g.states.length > 1;
        const device = await ctx.devices.upsert({
          id,
          name: g.name,
          protocol: 'ha',
          suggestedRoom: g.room,
          info: { manufacturer: g.manufacturer ?? 'Home Assistant', model: g.model },
          endpoints: g.states
            .map((s) => {
              const e = endpoints.get(s.entity_id)!;
              // "Hallway Motion Temperature" → "Temperature" (HA prefixes entity names with the device name).
              const friendly = String(s.attributes.friendly_name ?? s.entity_id);
              const prefix = g.prefixes.find((p) => friendly.startsWith(`${p} `));
              return { id: e.endpointId, deviceType: e.plan.deviceType, capabilities: e.plan.capabilities, ...(multi ? { name: prefix ? friendly.slice(prefix.length).trim() : friendly } : {}) };
            })
            .sort((a, b) => a.id - b.id),
        });
        bound.set(id, { device, endpoints });
        for (const s of g.states) {
          states.set(s.entity_id, s);
          entityToDevice.set(s.entity_id, id);
          const e = endpoints.get(s.entity_id)!;
          for (const u of stateToUpdates(e.plan, s)) device.update(e.endpointId, u.capability, u.attributes);
          for (const capability of e.plan.capabilities) {
            const commands = Object.keys(getCapability(capability)?.commands ?? {});
            if (!commands.length) continue;
            device.handle(
              e.endpointId,
              capability,
              Object.fromEntries(
                commands.map((command) => [
                  command,
                  async (params: Record<string, unknown>) => {
                    const call = commandToService(s.entity_id, capability, command, params, { on: device.get(e.endpointId, 'onOff', 'onOff') === true });
                    await client.send({ type: 'call_service', domain: call.domain, service: call.service, service_data: call.data ?? {}, target: { entity_id: s.entity_id } });
                  },
                ]),
              ),
            );
          }
        }
        refreshAvailability(id);
      }
      // Entities that disappeared from Home Assistant (or were excluded) disappear here too.
      for (const known of await ctx.devices.known()) {
        if (!groups.has(known.id)) {
          bound.delete(known.id);
          await ctx.devices.remove(known.id);
        }
      }
      ctx.log.info(`bridged ${groups.size} Home Assistant devices${skipped ? `, skipped ${skipped} entities Livynq already integrates` : ''}`);
    }

    client.connect();
    ctx.onStop(() => client.close());
  },
});

