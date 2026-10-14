import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineAdapter, type PluginContext, type PluginDevice } from '@livynq/sdk';
import { CloudError, XiaomiCloud, type CloudDevice, type Session } from './cloud.ts';
import { commandToWrites, featureCommands, planFeatures, readRefs, valuesToUpdates, type Feature, type PropWrite } from './mapping.ts';
import { MiioDevice, discover } from './miio.ts';
import { SpecStore } from './spec.ts';

/**
 * Xiaomi / Mijia devices.
 *
 *   plugins:
 *     - module: "@livynq/plugin-xiaomi"
 *       config:
 *         country: cn              # Mi Home server region: cn, de, us, ru, sg, i2
 *         cloud: false             # also use the cloud for devices the LAN cannot reach
 *         pollSeconds: 15
 *         devices:                 # optional: devices with known tokens (no account needed)
 *           - host: 192.168.1.40
 *             token: "0123456789abcdef0123456789abcdef"
 *
 * Usual setup: sign in once by scanning a QR code with the Mi Home app ("login" action). That
 * reads the device list with each device's LAN token; Wi-Fi devices are then controlled locally
 * over miIO / MIoT and keep working without internet. Device capabilities come from the public
 * MIoT spec (miot-spec.org, cached on first use).
 */

interface Known {
  did: string;
  name: string;
  model: string;
  token?: string;
  host?: string;
  /** Bluetooth / Zigbee sub-device of a gateway: only reachable through the cloud */
  subDevice?: boolean;
}

type Mode = 'local' | 'cloud' | 'none';

interface Status {
  did: string;
  id: string;
  name: string;
  model: string;
  host: string | null;
  mode: Mode;
  state: 'starting' | 'online' | 'offline' | 'unsupported' | 'error';
  error?: string;
  features: number;
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const writeSecret = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });

export default defineAdapter({
  async setup(ctx: PluginContext) {
    const country = typeof ctx.config.country === 'string' ? ctx.config.country : 'cn';
    const useCloud = ctx.config.cloud === true;
    const pollMs = Math.max(5, Number(ctx.config.pollSeconds ?? 15)) * 1000;
    const lanTimeoutMs = Number(ctx.config.lanTimeoutMs ?? 3000);
    const sessionFile = join(ctx.dataDir, 'account.json');
    const devicesFile = join(ctx.dataDir, 'devices.json');
    const specs = new SpecStore(ctx.dataDir, ctx.config.specBase ? { base: String(ctx.config.specBase) } : {});
    const cloud = new XiaomiCloud({
      session: existsSync(sessionFile) ? readJson<Session | undefined>(sessionFile, undefined) : undefined,
      ...(ctx.config.accountBase ? { accountBase: String(ctx.config.accountBase) } : {}),
      ...(ctx.config.apiBase ? { apiBase: String(ctx.config.apiBase) } : {}),
    });

    const fromConfig: Known[] = (Array.isArray(ctx.config.devices) ? (ctx.config.devices as Record<string, unknown>[]) : [])
      .filter((d) => typeof d.host === 'string' && typeof d.token === 'string')
      .map((d) => ({ did: String(d.did ?? `ip-${d.host}`), name: String(d.name ?? ''), model: String(d.model ?? ''), token: String(d.token), host: String(d.host) }));
    let known: Known[] = readJson<Known[]>(devicesFile, []);
    const runners = new Map<string, ReturnType<typeof runDevice>>();

    const runDevice = (k: Known) => {
      const id = `xiaomi:${k.did}`;
      const status: Status = { did: k.did, id, name: k.name, model: k.model, host: k.host ?? null, mode: 'none', state: 'starting', features: 0 };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      let failures = 0;
      let local: MiioDevice | undefined;
      let device: PluginDevice | undefined;
      let bound: { feature: Feature; endpointId: number }[] = [];

      const read = async (refs: { siid: number; piid: number }[]): Promise<Map<string, unknown>> => {
        const values = new Map<string, unknown>();
        for (let i = 0; i < refs.length; i += 15) {
          const chunk = refs.slice(i, i + 15).map((r) => ({ did: k.did, siid: r.siid, piid: r.piid }));
          const res = local
            ? await local.call<{ siid: number; piid: number; code: number; value?: unknown }[]>('get_properties', chunk)
            : await cloud.getProps(chunk);
          for (const r of res ?? []) if (r.code === 0) values.set(`${r.siid}.${r.piid}`, r.value);
        }
        return values;
      };

      const write = async (writes: PropWrite[]) => {
        if (!writes.length) return;
        const params = writes.map((w) => ({ did: k.did, siid: w.siid, piid: w.piid, value: w.value }));
        const res = local ? await local.call<{ code: number }[]>('set_properties', params) : await cloud.setProps(params);
        const bad = (res ?? []).find((r) => r.code !== 0);
        if (bad) throw new Error(`${k.name || k.model} refused the change (MIoT code ${bad.code})`);
      };

      const poll = async () => {
        if (closed || !device) return;
        try {
          const values = await read(bound.flatMap((b) => readRefs(b.feature)));
          for (const b of bound) for (const u of valuesToUpdates(b.feature, values)) device.update(b.endpointId, u.capability, u.attributes);
          failures = 0;
          if (status.state !== 'online') {
            status.state = 'online';
            delete status.error;
            device.setAvailability('online');
          }
        } catch (err) {
          failures++;
          status.error = (err as Error).message;
          // Each call already retries once, so two failed polls in a row mean the device is gone.
          if (failures >= 2 && status.state !== 'offline') {
            status.state = 'offline';
            device.setAvailability('offline');
            ctx.log.warn(`${k.name || k.did}: ${status.error}`);
          }
        }
        if (!closed) timer = setTimeout(() => void poll(), status.state === 'offline' ? Math.min(pollMs * 4, 120_000) : pollMs);
      };

      const start = async () => {
        // Model unknown (device added by IP + token): ask the device.
        if (!k.model && k.host && k.token) {
          const info = await new MiioDevice({ host: k.host, token: k.token }).call<{ model?: string }>('miIO.info');
          k.model = info?.model ?? '';
          status.model = k.model;
        }
        if (!k.model) throw new Error('unknown model');
        const spec = await specs.get(k.model);
        const features = planFeatures(spec);
        status.features = features.length;
        if (!features.length) {
          status.state = 'unsupported';
          status.error = `no supported functions in ${k.model} (${spec.description ?? 'unknown type'})`;
          return;
        }
        if (k.host && k.token && !k.subDevice) {
          local = new MiioDevice({ host: k.host, token: k.token, timeoutMs: lanTimeoutMs });
          status.mode = 'local';
        } else if (useCloud && cloud.session) status.mode = 'cloud';
        else {
          status.state = 'unsupported';
          status.error = k.subDevice ? 'gateway sub-device: enable "cloud" to use it' : 'no LAN address or token';
          return;
        }
        bound = await Promise.all(features.map(async (feature) => ({ feature, endpointId: await ctx.endpointId(id, feature.key) })));
        bound.sort((a, b) => a.endpointId - b.endpointId);
        device = await ctx.devices.upsert({
          id,
          name: k.name || spec.description || k.model,
          protocol: 'xiaomi',
          info: { manufacturer: k.model.split('.')[0] === 'yeelink' ? 'Yeelight' : 'Xiaomi', model: k.model },
          endpoints: bound.map((b) => ({ id: b.endpointId, deviceType: b.feature.deviceType, capabilities: b.feature.capabilities, ...(b.feature.name ? { name: b.feature.name } : {}) })),
        });
        const dev = device;
        for (const b of bound) {
          for (const [capability, commands] of Object.entries(featureCommands(b.feature))) {
            dev.handle(
              b.endpointId,
              capability,
              Object.fromEntries(
                commands.map((command) => [
                  command,
                  async (params: Record<string, unknown>) => {
                    const mode = dev.get(b.endpointId, 'thermostat', 'systemMode');
                    const on = dev.get(b.endpointId, 'onOff', 'onOff') === true || (mode !== undefined && mode !== 'off');
                    await write(commandToWrites(b.feature, capability, command, params, { on }));
                    // Read back what the device actually did.
                    clearTimeout(timer);
                    timer = setTimeout(() => void poll(), 400);
                  },
                ]),
              ),
            );
          }
        }
        await poll();
      };

      void start().catch((err: Error) => {
        status.state = 'error';
        status.error = err.message;
        ctx.log.warn(`${k.name || k.did} (${k.model || '?'}): ${err.message}`);
      });

      return {
        status: () => status,
        close() {
          closed = true;
          clearTimeout(timer);
          local?.close();
        },
      };
    };

    const startAll = () => {
      for (const r of runners.values()) r.close();
      runners.clear();
      const all = [...fromConfig, ...known.filter((k) => !fromConfig.some((c) => c.did === k.did))];
      for (const k of all) runners.set(k.did, runDevice(k));
    };

    /** Reads the account's device list (tokens, IPs) and (re)starts devices. */
    const sync = async () => {
      const list: CloudDevice[] = await cloud.devices();
      const previous = new Map(known.map((k) => [k.did, k]));
      known = list
        .filter((d) => d.model)
        .map((d) => ({
          did: d.did,
          name: d.name,
          model: d.model,
          ...(d.token && /^[0-9a-f]{32}$/i.test(d.token) ? { token: d.token } : {}),
          ...(d.localip ? { host: d.localip } : previous.get(d.did)?.host ? { host: previous.get(d.did)!.host } : {}),
          ...(d.did.startsWith('blt.') || d.parent_id || !d.localip ? { subDevice: true } : {}),
        }));
      writeSecret(devicesFile, known);
      // Devices that disappeared from the account are removed here too.
      for (const did of previous.keys()) if (!known.some((k) => k.did === did) && !fromConfig.some((c) => c.did === did)) await ctx.devices.remove(`xiaomi:${did}`);
      startAll();
      return { devices: known.length, local: known.filter((k) => k.host && k.token && !k.subDevice).length };
    };

    let login: { state: 'idle' | 'waiting' | 'done' | 'error'; loginUrl?: string; qrImage?: string; expiresAt?: number; error?: string; abort?: AbortController } = { state: 'idle' };

    ctx.actions.register('login', 'Sign in with the Mi Home app: returns a QR code URL to scan; poll "loginStatus"', async (p) => {
      login.abort?.abort();
      const region = typeof p.country === 'string' && p.country ? p.country : country;
      const qr = await cloud.startQrLogin();
      const abort = new AbortController();
      login = { state: 'waiting', loginUrl: qr.loginUrl, qrImage: qr.qrImage, expiresAt: qr.expiresAt, abort };
      void cloud
        .waitForScan(qr.pollUrl, region, abort.signal)
        .then(async (session) => {
          writeSecret(sessionFile, session);
          await sync();
          login = { state: 'done' };
          ctx.log.info('signed in to the Xiaomi account', { devices: known.length });
        })
        .catch((err: Error) => {
          if (abort.signal.aborted) return;
          login = { state: 'error', error: err.message };
        });
      return { loginUrl: qr.loginUrl, qrImage: qr.qrImage, expiresAt: qr.expiresAt };
    });
    ctx.actions.register('loginStatus', 'QR login progress and account state', () => ({
      state: login.state,
      ...(login.error ? { error: login.error } : {}),
      ...(login.state === 'waiting' ? { loginUrl: login.loginUrl, expiresAt: login.expiresAt } : {}),
      signedIn: Boolean(cloud.session),
      country: cloud.session?.country ?? country,
      cloud: useCloud,
      devices: runners.size,
    }));
    ctx.actions.register('logout', 'Forget the Xiaomi account session (devices with LAN tokens keep working)', () => {
      login.abort?.abort();
      login = { state: 'idle' };
      cloud.session = undefined;
      rmSync(sessionFile, { force: true });
      return { ok: true };
    });
    ctx.actions.register('sync', 'Re-read the device list from the Xiaomi account (new devices, changed IPs)', async () => {
      try {
        return await sync();
      } catch (err) {
        if (err instanceof CloudError && (err.code === 401 || err.code === 403)) throw new Error('The Xiaomi session expired: sign in again');
        throw err;
      }
    });
    ctx.actions.register('devices', 'Xiaomi devices and how each one is reached (local / cloud)', () => [...runners.values()].map((r) => r.status()));
    ctx.actions.register('add', 'Add a device by LAN address and token (from a token extractor): { host, token, name? }', async (p) => {
      const host = String(p.host ?? '').trim();
      const token = String(p.token ?? '').trim().toLowerCase();
      if (!host || !/^[0-9a-f]{32}$/.test(token)) throw new Error('host and a 32-character hex token are required');
      const dev = new MiioDevice({ host, token });
      let info: { model?: string; mac?: string };
      try {
        info = await dev.call<{ model?: string; mac?: string }>('miIO.info');
      } finally {
        dev.close();
      }
      const did = String(dev.deviceId || `ip-${host}`);
      const entry: Known = { did, name: String(p.name ?? ''), model: info?.model ?? '', token, host };
      known = [...known.filter((k) => k.did !== did), entry];
      writeSecret(devicesFile, known);
      runners.get(did)?.close();
      runners.set(did, runDevice(entry));
      return { did, model: entry.model };
    });
    ctx.actions.register('remove', 'Remove a Xiaomi device: { did }', async (p) => {
      const did = String(p.did ?? '');
      runners.get(did)?.close();
      runners.delete(did);
      known = known.filter((k) => k.did !== did);
      writeSecret(devicesFile, known);
      await ctx.devices.remove(`xiaomi:${did}`);
      return { removed: did };
    });
    ctx.actions.register('discover', 'Xiaomi Wi-Fi devices answering on the LAN (ids only; tokens need the account)', async () => {
      const found = await discover(2000);
      return found.map((f) => ({ ...f, known: known.some((k) => k.host === f.host || k.did === String(f.deviceId)) }));
    });

    startAll();
    ctx.onStop(() => {
      login.abort?.abort();
      for (const r of runners.values()) r.close();
    });
  },
});
