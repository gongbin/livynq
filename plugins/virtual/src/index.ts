import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineAdapter, DeviceTypes } from '@livynq/sdk';

/**
 * Virtual switches, persisted across restarts. Expose them to Apple Home and use them as
 * Siri-triggerable scenes ("Hey Siri, good night") that start Livynq automations.
 *
 *   plugins:
 *     - module: "@livynq/plugin-virtual"
 *       config:
 *         switches:
 *           - { id: guest-mode, name: Guest Mode }
 *           - { id: good-night, name: Good Night, momentary: true }   # turns itself off after 1 s
 */
interface SwitchConfig {
  id: string;
  name: string;
  momentary?: boolean;
}

export default defineAdapter({
  async setup(ctx) {
    const switches = (Array.isArray(ctx.config.switches) ? ctx.config.switches : []) as SwitchConfig[];
    const file = join(ctx.dataDir, 'state.json');
    let saved: Record<string, boolean> = {};
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, boolean>;
    } catch {
      // first run
    }
    const persist = () => writeFileSync(file, JSON.stringify(saved, null, 2));

    const wanted = new Set<string>();
    for (const sw of switches) {
      if (!sw?.id || !/^[a-z0-9_-]+$/i.test(sw.id)) {
        ctx.log.warn('skipping switch with invalid id', { switch: sw as unknown as Record<string, unknown> });
        continue;
      }
      const id = `virtual:${sw.id}`;
      wanted.add(id);
      const device = await ctx.devices.upsert({
        id,
        name: sw.name ?? sw.id,
        protocol: 'virtual',
        info: { manufacturer: 'Livynq', model: sw.momentary ? 'Virtual Button' : 'Virtual Switch' },
        endpoints: [{ id: 1, deviceType: DeviceTypes.OnOffSwitch.id, capabilities: ['onOff'] }],
      });
      let resetTimer: NodeJS.Timeout | undefined;
      const set = (on: boolean) => {
        clearTimeout(resetTimer);
        device.update(1, 'onOff', { onOff: on });
        if (!sw.momentary) {
          saved[sw.id] = on;
          persist();
        } else if (on) {
          resetTimer = setTimeout(() => device.update(1, 'onOff', { onOff: false }), 1000);
        }
      };
      device.handle(1, 'onOff', {
        on: () => set(true),
        off: () => set(false),
        toggle: () => set(!device.get(1, 'onOff', 'onOff')),
      });
      device.update(1, 'onOff', { onOff: sw.momentary ? false : (saved[sw.id] ?? false) });
      device.setAvailability('online');
    }
    // Switches removed from the config disappear from the hub (and Apple Home).
    for (const known of await ctx.devices.known()) if (!wanted.has(known.id)) await ctx.devices.remove(known.id);
    ctx.log.info(`${wanted.size} virtual switches ready`);
  },
});
