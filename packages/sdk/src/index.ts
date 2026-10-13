/**
 * @livynq/sdk — write Livynq plugins against the unified capability model.
 * Plugins never deal with HomeKit, Matter, MCP or the UI: exposing devices there is the hub's job.
 *
 *   export default defineAdapter({
 *     async setup(ctx) {
 *       const lamp = await ctx.devices.upsert({ id: 'acme:1', name: 'Lamp', protocol: 'lan',
 *         endpoints: [{ id: 1, deviceType: DeviceTypes.OnOffLight.id, capabilities: ['onOff'] }] });
 *       lamp.handle(1, 'onOff', { on: () => api.on(), off: () => api.off(), toggle: () => api.toggle() });
 *       api.onChange((on) => lamp.update(1, 'onOff', { onOff: on }));
 *       lamp.setAvailability('online');
 *     },
 *   });
 */
import type { AttributeValue, Availability, Device, DeviceDefinition } from '@livynq/model';

export * from '@livynq/model';

export type CommandHandler = (params: Record<string, unknown>) => void | Promise<void>;

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface PluginDevice {
  readonly id: string;
  /** Report attribute values (e.g. after the device confirms a change). */
  update(endpointId: number, capability: string, attributes: Record<string, AttributeValue>): void;
  /** Last value known to the hub for this device. */
  get(endpointId: number, capability: string, attribute: string): AttributeValue | undefined;
  setAvailability(availability: Availability): void;
  /** Register command handlers; they run when Apple Home, the UI, an automation or an agent sends a command. */
  handle(endpointId: number, capability: string, handlers: Record<string, CommandHandler>): void;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly log: PluginLogger;
  /** The `config` block of this plugin in livynq.yaml. */
  readonly config: Record<string, unknown>;
  /** Private, persistent directory for this plugin. */
  readonly dataDir: string;
  readonly devices: {
    upsert(def: DeviceDefinition): Promise<PluginDevice>;
    remove(id: string): Promise<void>;
    /** Devices this plugin registered in earlier runs. */
    known(): Promise<Device[]>;
    /** Whether any integration already provides this device (avoid duplicates when bridging). */
    exists(id: string): Promise<boolean>;
  };
  /** Stable numeric endpoint id for a plugin-specific key, persisted by the hub. */
  endpointId(deviceId: string, key: string): Promise<number>;
  /** Called when the hub stops or reloads the plugin. */
  onStop(fn: () => void | Promise<void>): void;
  /**
   * Operations users can trigger from the UI / CLI / API (admin only), e.g. "commission" with a
   * Matter pairing code or "permitJoin" for Zigbee. The handler's result is returned to the caller.
   */
  readonly actions: {
    register(name: string, description: string, handler: (params: Record<string, unknown>) => unknown): void;
  };
}

export interface PluginDefinition {
  readonly kind: 'adapter';
  setup(ctx: PluginContext): void | Promise<void>;
}

export function defineAdapter(def: { setup(ctx: PluginContext): void | Promise<void> }): PluginDefinition {
  return { kind: 'adapter', setup: def.setup };
}

export function isPluginDefinition(value: unknown): value is PluginDefinition {
  return typeof value === 'object' && value !== null && (value as PluginDefinition).kind === 'adapter' && typeof (value as PluginDefinition).setup === 'function';
}
