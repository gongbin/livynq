import { accessSync, constants, existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { LivynqConfig } from '../config.ts';

/**
 * `livynq doctor`: checks the things that usually go wrong on a new install — config, data
 * directory permissions, disk space, ports, LAN interfaces (HomeKit / Matter need one), serial
 * sticks, backups — and, when the hub runs, plugin errors and offline devices.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface DoctorDeps {
  /** GET against the running hub (authenticated); undefined when it is not reachable. */
  hub?: { get<T>(path: string): Promise<T> } | undefined;
  /** A Livynq hub answers on the web port, but the local token was not accepted (another data dir?). */
  otherHub?: boolean;
  portFree?: (port: number, host?: string) => Promise<boolean>;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  now?: number;
}

export function portFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

const DAY = 86_400_000;

export async function runDoctor(config: LivynqConfig, deps: DoctorDeps = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, message: string, hint?: string) => checks.push({ name, status, message, ...(hint ? { hint } : {}) });
  const now = deps.now ?? Date.now();

  const [major] = process.versions.node.split('.').map(Number);
  if (major! >= 24) add('runtime', 'ok', `Node.js ${process.versions.node}`);
  else add('runtime', 'fail', `Node.js ${process.versions.node} is too old`, 'Livynq needs Node.js 24 or newer (or use the single-file binary)');

  // Data directory
  const dir = config.dataDir;
  if (!existsSync(dir)) add('data directory', 'warn', `${dir} does not exist yet`, 'It is created on the first "livynq start"');
  else {
    try {
      accessSync(dir, constants.W_OK);
      add('data directory', 'ok', dir);
    } catch {
      add('data directory', 'fail', `${dir} is not writable by this user`, 'Run as the user that owns it, or fix ownership (chown -R)');
    }
    const secrets = join(dir, 'secrets');
    if (existsSync(secrets) && process.platform !== 'win32') {
      const loose = [secrets, ...readdirSync(secrets).map((f) => join(secrets, f))].filter((p) => (statSync(p).mode & 0o077) !== 0);
      if (loose.length) add('secrets', 'warn', `${loose.length} secret file(s) readable by other users`, `chmod -R go-rwx ${secrets}`);
      else add('secrets', 'ok', 'only readable by the owner');
    }
    try {
      const fs = statfsSync(dir);
      const free = fs.bavail * fs.bsize;
      const mb = Math.round(free / 1024 / 1024);
      if (free < 200 * 1024 * 1024) add('disk space', 'fail', `${mb} MB free`, 'The history database and backups need space; free up the disk');
      else if (free < 1024 * 1024 * 1024) add('disk space', 'warn', `${mb} MB free`);
      else add('disk space', 'ok', `${(free / 1024 ** 3).toFixed(1)} GB free`);
    } catch {
      // statfs not supported here
    }
    const backups = join(dir, 'backups');
    const latest = existsSync(backups) ? Math.max(0, ...readdirSync(backups).map((f) => statSync(join(backups, f)).mtimeMs)) : 0;
    if (!latest) add('backups', 'warn', 'no backup yet', config.backup.automatic ? 'Automatic backups run daily while the hub runs' : 'Enable backup.automatic or run "livynq backup create"');
    else if (now - latest > 8 * DAY) add('backups', 'warn', `last backup ${Math.floor((now - latest) / DAY)} days ago`);
    else add('backups', 'ok', `last backup ${new Date(latest).toLocaleString()}`);
  }

  // LAN: HomeKit and Matter advertise over mDNS and must be reachable from phones / speakers.
  const lan = Object.entries((deps.interfaces ?? networkInterfaces)())
    .flatMap(([name, addrs]) => (addrs ?? []).filter((a) => !a.internal && a.family === 'IPv4').map((a) => `${name} ${a.address}`));
  if (!lan.length) add('network', 'fail', 'no LAN IPv4 address', 'HomeKit and Matter need the hub on the same network as your phone (use host networking in Docker)');
  else add('network', 'ok', lan.slice(0, 3).join(', '));

  // Ports (only meaningful when the hub is not running; otherwise it holds them itself)
  const free = deps.portFree ?? portFree;
  const ports: [string, number, boolean][] = [
    ['web / API', config.server.port, true],
    ['HomeKit', config.homekit.port, config.homekit.enabled],
    ['Matter bridge', config.matter.bridge.port, config.matter.bridge.enabled],
    ['MQTT broker', config.mqtt.broker.port, config.mqtt.broker.builtin],
  ];
  if (deps.otherHub) {
    add('hub', 'warn', `a Livynq hub runs on port ${config.server.port}, but not with the data directory ${dir}`, 'Pass --data <dir> (or LIVYNQ_DATA_DIR) to check that instance');
  } else if (!deps.hub) {
    add('hub', 'warn', 'not running', 'Start it with "livynq start" (or systemctl start livynq)');
    for (const [name, port, enabled] of ports) {
      if (!enabled) continue;
      if (await free(port)) add(`port ${port}`, 'ok', `${name}: free`);
      else add(`port ${port}`, 'fail', `${name}: port ${port} is in use by another program`, 'Stop it, or change the port in livynq.yaml');
    }
  } else {
    const info = await deps.hub.get<{ version: string; adapters: string[] }>('/api/v1/system/info').catch(() => undefined);
    add('hub', 'ok', `running${info ? ` (Livynq ${info.version})` : ''}`);
    const plugins = await deps.hub.get<{ id: string; status: string; lastError?: string | null }[]>('/api/v1/plugins').catch(() => []);
    for (const p of plugins) {
      if (p.status === 'running') add(`plugin ${p.id}`, 'ok', 'running');
      else add(`plugin ${p.id}`, p.status === 'stopped' ? 'warn' : 'fail', `${p.status}${p.lastError ? `: ${p.lastError}` : ''}`, `livynq plugin restart ${p.id}`);
    }
    const devices = await deps.hub.get<{ name: string; availability: string }[]>('/api/v1/devices').catch(() => []);
    const offline = devices.filter((d) => d.availability === 'offline');
    if (offline.length) add('devices', 'warn', `${offline.length} of ${devices.length} offline: ${offline.slice(0, 5).map((d) => d.name).join(', ')}${offline.length > 5 ? ', …' : ''}`);
    else add('devices', 'ok', `${devices.length} devices, all reachable`);
  }

  // Serial sticks named in plugin configs
  for (const p of config.plugins) {
    if (p.enabled === false) continue;
    const port = p.config?.serialPort ?? p.config?.port;
    if (typeof port !== 'string' || !port.startsWith('/')) continue;
    const name = p.id ?? p.module ?? 'plugin';
    if (!existsSync(port)) add(`serial ${name}`, 'fail', `${port} not found`, 'Is the stick plugged in? Prefer /dev/serial/by-id/… paths, which survive reboots');
    else {
      try {
        accessSync(port, constants.R_OK | constants.W_OK);
        add(`serial ${name}`, 'ok', port);
      } catch {
        add(`serial ${name}`, 'fail', `no permission to open ${port}`, 'Add the user to the "dialout" group (Linux), then log in again');
      }
    }
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icon = { ok: '✔', warn: '!', fail: '✖' } as const;
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${icon[c.status]} ${c.name.padEnd(width)}  ${c.message}${c.hint ? `\n  ${' '.repeat(width)}  → ${c.hint}` : ''}`);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  return `${lines.join('\n')}\n\n${fails ? `${fails} problem(s)` : 'No problems found'}${warns ? `, ${warns} warning(s)` : ''}`;
}
