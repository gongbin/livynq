import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MIoT-Spec-V2: Xiaomi's public description of every device model (services → properties /
 * actions with ids, formats, ranges and enums), served by miot-spec.org. Fetched once per model
 * and cached in the plugin data directory, so devices keep working offline afterwards.
 */

export interface SpecProperty {
  iid: number;
  type: string;
  description?: string;
  format: string;
  access: string[];
  unit?: string;
  'value-range'?: [number, number, number];
  'value-list'?: { value: number; description: string }[];
}

export interface SpecAction {
  iid: number;
  type: string;
  description?: string;
  in: number[];
  out: number[];
}

export interface SpecService {
  iid: number;
  type: string;
  description?: string;
  properties?: SpecProperty[];
  actions?: SpecAction[];
}

export interface DeviceSpec {
  type: string;
  description?: string;
  services: SpecService[];
}

/** "urn:miot-spec-v2:property:color-temperature:0000000F:yeelink-color1:1" → "color-temperature" */
export const urnName = (urn: string) => urn.split(':')[3] ?? '';

const BASE = 'https://miot-spec.org/miot-spec-v2';

export class SpecStore {
  readonly #dir: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  #instances: Promise<Map<string, string>> | undefined;

  constructor(dir: string, options: { fetch?: typeof fetch; base?: string } = {}) {
    this.#dir = join(dir, 'specs');
    this.#fetch = options.fetch ?? fetch;
    this.#base = options.base ?? BASE;
  }

  /** model ("yeelink.light.color1") → spec, from cache or miot-spec.org */
  async get(model: string): Promise<DeviceSpec> {
    const file = join(this.#dir, `${model.replace(/[^a-z0-9._-]/gi, '_')}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as DeviceSpec;
    const type = (await this.#instanceTypes()).get(model);
    if (!type) throw new Error(`no MIoT spec published for ${model} (older miIO-only model?)`);
    const res = await this.#fetch(`${this.#base}/instance?type=${encodeURIComponent(type)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`miot-spec.org: HTTP ${res.status}`);
    const spec = (await res.json()) as DeviceSpec;
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(file, JSON.stringify(spec));
    return spec;
  }

  /** Released spec type per model (latest version wins). */
  #instanceTypes(): Promise<Map<string, string>> {
    this.#instances ??= (async () => {
      const res = await this.#fetch(`${this.#base}/instances?status=released`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`miot-spec.org: HTTP ${res.status}`);
      const body = (await res.json()) as { instances: { model: string; type: string; version: number }[] };
      const best = new Map<string, { type: string; version: number }>();
      for (const i of body.instances) {
        const cur = best.get(i.model);
        if (!cur || i.version > cur.version) best.set(i.model, { type: i.type, version: i.version });
      }
      return new Map([...best].map(([m, v]) => [m, v.type]));
    })();
    this.#instances.catch(() => (this.#instances = undefined));
    return this.#instances;
  }
}
