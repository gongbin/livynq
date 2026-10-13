#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { parseArgs } from 'node:util';
import { actionToCommand, actions, describeCommands, endpointForTarget, serveMcpStdio, summarizeDevice, type Action } from '@livynq/agent';
import type { TokenScope } from '@livynq/model';
import { loadConfig, updatePluginsInConfig, type ConfigOverrides } from './config.ts';
import { ApiError, RemoteClient, resolveRemote } from './cli/remote.ts';
import { deviceRows, table } from './cli/format.ts';
import { VERSION } from './version.ts';
import type { ImportPlan } from '@livynq/importer-homeassistant';
import type { PluginEntry } from '@livynq/plugin-host';

type HaReport = Omit<ImportPlan, 'operations'>;

const HELP = `livynq ${VERSION} — lightweight, local-first smart home hub

Usage: livynq <command> [options]

Server
  start                         Run the hub
      --data <dir>              Data directory (default ~/.livynq, env LIVYNQ_DATA_DIR)
      --port <n>  --host <h>    HTTP/API/MCP listen address (default 0.0.0.0:8581)
      --demo                    Add simulated devices
      --mqtt <url>              MQTT broker (Home Assistant discovery), e.g. mqtt://192.168.1.2
      --builtin-broker          Run an embedded MQTT broker on :1883
      --no-homekit              Do not start the HomeKit bridge
  login-url                     Print a web UI login link (local machine only)

Client (talks to a running hub; --url/--token or LIVYNQ_URL/LIVYNQ_TOKEN for remote)
  status                        Hub summary
  devices list [--room R] [--domain light|switch|sensor|binary_sensor] [--q text]
  devices get <target>          State and accepted commands
  call <target> <action> [--brightness N] [--kelvin K] [--hue H --saturation S]
                                Actions: ${actions.filter((a) => a !== 'raw').join(', ')}
  call <target> <capability>.<command> [--params JSON]
  rooms list
  import ha <dir|backup.tar> [--dry-run] [--enable-automations]
                                Import areas, devices, entity ids and automations from Home Assistant
  imports list | imports revert <id>
  plugin list | plugin restart <id>
  plugin add <npm-package | ./path> [--isolation in-process]   Install and enable a plugin (restart to load)
  plugin remove <id>
  backup create [--out file] [--password P]    Download a backup from the running hub
  backup restore <file> [--password P]         Restore into the data dir (stop the hub first)
  backup inspect <file> [--password P]
  automations list | get <id> | traces <id> | trigger <id> | enable <id> | disable <id> | delete <id>
  automations apply <file.yaml> [--dry-run] [--disabled]
                                Create or update from Home Assistant style YAML
  tokens list | tokens create <name> [--scope read|control|admin] | tokens revoke <id>
  mcp                           MCP server over stdio (for Claude Desktop, Cursor, ...)

Targets are entity ids (light.kitchen), device ids (zigbee:0x...), names or aliases.
Add --json to any client command for machine-readable output.
`;

// `pnpm livynq -- start` forwards the separator literally; it is never meaningful here.
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));

const { values: flags, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  strict: false,
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    demo: { type: 'boolean' },
    mqtt: { type: 'string' },
    'builtin-broker': { type: 'boolean' },
    'no-homekit': { type: 'boolean' },
    'log-level': { type: 'string' },
    url: { type: 'string' },
    token: { type: 'string' },
    json: { type: 'boolean' },
    room: { type: 'string' },
    domain: { type: 'string' },
    q: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'enable-automations': { type: 'boolean' },
    out: { type: 'string' },
    isolation: { type: 'string' },
    password: { type: 'string' },
    disabled: { type: 'boolean' },
    scope: { type: 'string' },
    params: { type: 'string' },
    brightness: { type: 'string' },
    kelvin: { type: 'string' },
    hue: { type: 'string' },
    saturation: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
const num = (k: string) => (str(k) === undefined ? undefined : Number(str(k)));
const asJson = Boolean(flags.json);

function overrides(): ConfigOverrides {
  return {
    dataDir: str('data'),
    port: num('port'),
    host: str('host'),
    demo: flags.demo ? true : undefined,
    homekit: flags['no-homekit'] ? false : undefined,
    mqttUrl: str('mqtt'),
    builtinBroker: flags['builtin-broker'] ? true : undefined,
    logLevel: str('log-level'),
  };
}

function client(): RemoteClient {
  const config = loadConfig(overrides());
  return new RemoteClient(resolveRemote({ url: str('url'), token: str('token'), dataDir: config.dataDir, port: config.server.port }));
}

function print(human: string, data: unknown): void {
  process.stdout.write(`${asJson ? JSON.stringify(data, null, 2) : human}\n`);
}

async function run(): Promise<void> {
  const [cmd, sub, ...rest] = positionals;
  if (flags.version) return print(VERSION, { version: VERSION });
  if (!cmd || flags.help || cmd === 'help') return void process.stdout.write(HELP);

  switch (cmd) {
    case 'start': {
      const { startLivynq } = await import('./start.ts');
      const instance = await startLivynq(loadConfig(overrides()));
      const shutdown = async () => {
        await instance.stop();
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      return;
    }
    case 'login-url': {
      const config = loadConfig(overrides());
      const remote = resolveRemote({ url: str('url'), token: str('token'), dataDir: config.dataDir, port: config.server.port });
      return print(`${remote.url}/#token=${remote.token}`, { url: `${remote.url}/#token=${remote.token}` });
    }
    case 'status': {
      const c = client();
      const [info, devices, rooms] = await Promise.all([c.info(), c.devices(), c.rooms()]);
      const offline = devices.filter((d) => d.availability === 'offline').length;
      return print(
        [
          `Livynq ${info.version} — up since ${new Date(info.startedAt).toLocaleString()}`,
          `devices: ${devices.length} (${offline} offline)   rooms: ${rooms.length}`,
          `adapters: ${info.adapters.join(', ') || 'none'}   homekit: ${info.homekit.enabled ? 'on' : 'off'}`,
        ].join('\n'),
        { ...info, rooms: rooms.length, offline },
      );
    }
    case 'devices': {
      const c = client();
      if (sub === 'get' && rest[0]) {
        const device = await c.device(rest[0]);
        const summary = { ...summarizeDevice(device), info: device.info, commands: describeCommands(device) };
        return print(JSON.stringify(summary, null, 2), summary);
      }
      if (sub && sub !== 'list') throw new ApiError(400, 'INVALID_PARAMS', `Unknown subcommand devices ${sub}`);
      const devices = await c.devices({ room: str('room'), domain: str('domain'), q: str('q') });
      return print(table(deviceRows(devices)), devices.map(summarizeDevice));
    }
    case 'call': {
      const target = sub;
      const what = rest[0];
      if (!target || !what) throw new ApiError(400, 'INVALID_PARAMS', 'Usage: livynq call <target> <action | capability.command>');
      const body = what.includes('.')
        ? { capability: what.split('.')[0]!, command: what.split('.')[1]!, params: str('params') ? (JSON.parse(str('params')!) as Record<string, unknown>) : {} }
        : actionToCommand(what as Action, {
            brightness: num('brightness'),
            colorTemperature: num('kelvin'),
            hue: num('hue'),
            saturation: num('saturation'),
          });
      const c = client();
      const device = await c.device(target);
      const endpointId = endpointForTarget(device, target, body.capability);
      await c.command(device.id, endpointId, body);
      return print(`ok: ${device.name} ← ${body.capability}.${body.command}`, { ok: true, deviceId: device.id, endpointId, ...body });
    }
    case 'automations': {
      const c = client();
      const id = rest[0];
      const path = (suffix = '') => `/api/v1/automations/${encodeURIComponent(id ?? '')}${suffix}`;
      const need = () => {
        if (!id) throw new ApiError(400, 'INVALID_PARAMS', `Usage: livynq automations ${sub} <id>`);
      };
      switch (sub ?? 'list') {
        case 'list': {
          const list = await c.automations();
          return print(
            table(list.map((a) => ({ id: a.id, alias: a.alias, enabled: a.enabled ? 'on' : 'off', valid: a.valid ? 'ok' : 'INVALID', last: a.lastTriggered ? new Date(a.lastTriggered).toLocaleString() : '', by: a.createdBy }))),
            list,
          );
        }
        case 'get': {
          need();
          const info = await c.request<Record<string, unknown>>('GET', path());
          return print(JSON.stringify(info, null, 2), info);
        }
        case 'traces': {
          need();
          const traces = await c.automationTraces(id!);
          return print(
            table(traces.map((t) => ({ run: t.runId.slice(0, 8), started: new Date(t.startedAt).toLocaleString(), state: t.state, trigger: t.trigger.description, note: t.error ?? t.stopReason ?? '' }))),
            traces,
          );
        }
        case 'trigger': {
          need();
          const r = await c.request<{ runId: string | null }>('POST', path('/trigger'), {});
          return print(r.runId ? `started run ${r.runId}` : 'not started (mode refused or queued)', r);
        }
        case 'enable':
        case 'disable': {
          need();
          const r = await c.request<Record<string, unknown>>('POST', path(`/${sub}`), {});
          return print(`${id}: ${sub}d`, r);
        }
        case 'delete': {
          need();
          await c.request('DELETE', path());
          return print(`${id}: deleted`, { ok: true });
        }
        case 'apply': {
          const file = id;
          if (!file) throw new ApiError(400, 'INVALID_PARAMS', 'Usage: livynq automations apply <file.yaml>');
          const { readFileSync } = await import('node:fs');
          const { parse } = await import('yaml');
          const doc = parse(readFileSync(file, 'utf8')) as unknown;
          const configs = (Array.isArray(doc) ? doc : [doc]) as Record<string, unknown>[];
          const results: Record<string, unknown>[] = [];
          for (const config of configs) {
            const v = await c.request<{ ok: boolean; errors: string[]; automation?: { id: string } }>('POST', '/api/v1/automations/validate', config);
            const label = v.automation?.id ?? String(config.alias ?? config.id ?? '?');
            if (!v.ok) {
              results.push({ id: label, ok: false, errors: v.errors });
              continue;
            }
            if (flags['dry-run']) {
              results.push({ id: label, ok: true, dryRun: true });
              continue;
            }
            const existing = (await c.automations()).some((a) => a.id === label);
            const saved = existing
              ? await c.request<{ id: string; version: number }>('PUT', `/api/v1/automations/${encodeURIComponent(label)}`, config)
              : await c.request<{ id: string; version: number }>('POST', `/api/v1/automations${flags.disabled ? '?enabled=false' : ''}`, config);
            results.push({ id: saved.id, ok: true, version: saved.version, action: existing ? 'updated' : 'created' });
          }
          const failed = results.filter((r) => !r.ok);
          print(
            results.map((r) => (r.ok ? `✓ ${r.id} ${r.dryRun ? '(valid)' : `${r.action} v${r.version}`}` : `✗ ${r.id}\n    ${(r.errors as string[]).join('\n    ')}`)).join('\n'),
            results,
          );
          if (failed.length) process.exitCode = 1;
          return;
        }
        default:
          throw new ApiError(400, 'INVALID_PARAMS', `Unknown subcommand automations ${sub}`);
      }
    }
    case 'import': {
      if (sub !== 'ha' && sub !== 'homeassistant') throw new ApiError(400, 'INVALID_PARAMS', 'Usage: livynq import ha <dir|backup.tar> [--dry-run]');
      if (!rest[0]) throw new ApiError(400, 'INVALID_PARAMS', 'Missing path to the Home Assistant config directory or backup');
      const { resolve } = await import('node:path');
      const path = resolve(rest[0]);
      const c = client();
      const dryRun = Boolean(flags['dry-run']);
      const result = dryRun
        ? { report: await c.request<HaReport>('POST', '/api/v1/imports/homeassistant/plan', { path }) }
        : await c.request<{ import: { id: string; applied: { failed: unknown[] } }; report: HaReport }>('POST', '/api/v1/imports/homeassistant/apply', {
            path,
            enableAutomations: Boolean(flags['enable-automations']),
          });
      const r = result.report;
      const lines = [
        `Home Assistant ${r.haVersion ?? '?'} — ${r.source}`,
        `rooms: ${r.rooms.map((x) => `${x.name}${x.action === 'create' ? ' (new)' : ''}`).join(', ') || 'none'}`,
        `devices: ${r.summary.devicesMatched} matched, ${r.summary.devicesPending} pending, ${r.summary.devicesUnsupported} unsupported · entity ids adopted from HA: ${r.summary.entityRenames}`,
        ...r.devices.filter((d) => d.status !== 'matched').map((d) => `  · ${d.name} [${d.status}] ${d.reason ?? ''}`),
        `automations: ${r.summary.automations} importable, ${r.summary.automationsInvalid} need changes${dryRun ? '' : flags['enable-automations'] ? ' (imported enabled)' : ' (imported disabled)'}`,
        ...r.automations.filter((a) => a.status !== 'import').map((a) => `  · ${a.alias} [${a.status}] ${a.errors.join('; ')}`),
        ...r.automations.filter((a) => a.missingEntities.length).map((a) => `  · ${a.alias}: unknown entities ${a.missingEntities.join(', ')}`),
        `not imported yet: ${r.notImported.scripts} scripts, ${r.notImported.scenes} scenes, ${r.notImported.blueprints} blueprints, ${r.notImported.floors} floors`,
        ...(r.location ? [`location (add to livynq.yaml): latitude ${r.location.latitude}, longitude ${r.location.longitude}`] : []),
        ...r.warnings.map((w) => `warning: ${w}`),
        dryRun ? '\nDry run: nothing changed. Run without --dry-run to apply.' : `\nImported. Undo with: livynq imports revert ${'import' in result ? result.import.id : ''}`,
      ];
      return print(lines.join('\n'), result);
    }
    case 'plugin':
    case 'plugins': {
      if (sub === 'add' && rest[0]) {
        const config = loadConfig(overrides());
        const target = rest[0];
        const isPath = target.startsWith('.') || target.startsWith('/');
        if (!isPath) {
          const { execFileSync } = await import('node:child_process');
          const { mkdirSync } = await import('node:fs');
          const prefix = `${config.dataDir}/plugins`;
          mkdirSync(prefix, { recursive: true });
          process.stderr.write(`installing ${target} into ${prefix} …\n`);
          execFileSync('npm', ['install', '--prefix', prefix, '--omit=dev', '--no-fund', '--no-audit', target], { stdio: ['ignore', 'inherit', 'inherit'] });
        }
        const { resolve } = await import('node:path');
        const name = isPath ? undefined : target.replace(/(?<=.)@[^/]+$/, '');
        const entry: PluginEntry = { ...(isPath ? { path: resolve(target) } : { module: name }), ...(str('isolation') === 'in-process' ? { isolation: 'in-process' as const } : {}) };
        updatePluginsInConfig(config.configFile, { add: entry });
        return print(`added to ${config.configFile}; restart Livynq to load it`, { ok: true, entry });
      }
      if (sub === 'remove' && rest[0]) {
        const config = loadConfig(overrides());
        const removed = updatePluginsInConfig(config.configFile, {
          remove: (p) => {
            const id = p.id ?? (p.module ?? p.path ?? '').replace(/^.*\//, '').replace(/^livynq-plugin-|^plugin-/, '').replace(/\.(ts|js)$/, '');
            return id === rest[0] || p.module === rest[0];
          },
        });
        if (!removed) throw new ApiError(404, 'NOT_FOUND', `No plugin "${rest[0]}" in ${config.configFile}`);
        return print('removed from config; restart Livynq to unload it', { ok: true });
      }
      const c = client();
      if (sub === 'restart' && rest[0]) {
        const info = await c.request<Record<string, unknown>>('POST', `/api/v1/plugins/${encodeURIComponent(rest[0])}/restart`, {});
        return print(`${rest[0]}: ${String(info.status)}`, info);
      }
      const list = await c.request<Record<string, unknown>[]>('GET', '/api/v1/plugins');
      return print(table(list.map((p) => ({ id: p.id, status: p.status, isolation: p.isolation, pid: p.pid ?? '', restarts: p.restarts ?? '', devices: p.devices ?? '', error: p.lastError ?? '' }))), list);
    }
    case 'backup': {
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { readBackupManifest, restoreBackup } = await import('@livynq/core');
      if (sub === 'create') {
        const config = loadConfig(overrides());
        const remote = resolveRemote({ url: str('url'), token: str('token'), dataDir: config.dataDir, port: config.server.port });
        const res = await fetch(`${remote.url}/api/v1/system/backup`, {
          method: 'POST',
          headers: { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(str('password') ? { password: str('password') } : {}),
        }).catch(() => {
          throw new ApiError(0, 'UNREACHABLE', `Cannot reach Livynq at ${remote.url}`);
        });
        if (!res.ok) {
          const e = ((await res.json().catch(() => ({}))) as { error?: { code: string; message: string } }).error;
          throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? res.statusText);
        }
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'livynq-backup.tar.gz';
        const out = str('out') ?? name;
        const data = Buffer.from(await res.arrayBuffer());
        writeFileSync(out, data, { mode: 0o600 });
        return print(`backup written: ${out} (${(data.length / 1024).toFixed(0)} KB)`, { file: out, bytes: data.length });
      }
      if ((sub === 'restore' || sub === 'inspect') && rest[0]) {
        const data = readFileSync(rest[0]);
        if (sub === 'inspect') {
          const manifest = readBackupManifest(data, str('password'));
          return print(JSON.stringify(manifest, null, 2), manifest);
        }
        const config = loadConfig(overrides());
        const running = await fetch(`http://127.0.0.1:${config.server.port}/api/v1/health`).then(() => true, () => false);
        if (running) throw new ApiError(409, 'CONFLICT', 'Livynq is running', 'Stop it first (e.g. systemctl stop livynq), then restore');
        const result = restoreBackup(data, config.dataDir, { password: str('password') });
        return print(
          `restored backup from ${new Date(result.manifest.createdAt).toLocaleString()} (Livynq ${result.manifest.livynqVersion}) into ${config.dataDir}` +
            (result.previous ? `\nprevious data kept at ${result.previous}` : ''),
          result,
        );
      }
      throw new ApiError(400, 'INVALID_PARAMS', 'Usage: livynq backup create|restore <file>|inspect <file>');
    }
    case 'imports': {
      const c = client();
      if (sub === 'revert' && rest[0]) {
        const r = await c.request<{ reverted: number; skipped: string[] }>('POST', `/api/v1/imports/${encodeURIComponent(rest[0])}/revert`, {});
        return print(`reverted ${r.reverted} changes${r.skipped.length ? `; skipped:\n  ${r.skipped.join('\n  ')}` : ''}`, r);
      }
      const list = await c.request<{ id: string; source: string; createdAt: number; revertedAt: number | null; summary: Record<string, number> }[]>('GET', '/api/v1/imports');
      return print(
        table(list.map((i) => ({ id: i.id, when: new Date(i.createdAt).toLocaleString(), source: i.source, devices: i.summary.devicesMatched, automations: i.summary.automations, reverted: i.revertedAt ? 'yes' : '' }))),
        list,
      );
    }
    case 'rooms': {
      const rooms = await client().rooms();
      return print(table(rooms.map((r) => ({ id: r.id, name: r.name, aliases: r.aliases.join(', ') }))), rooms);
    }
    case 'tokens': {
      const c = client();
      if (sub === 'create') {
        const scope = (str('scope') ?? 'read') as TokenScope;
        const created = await c.request<{ token: string; info: { id: string } }>('POST', '/api/v1/tokens', { name: rest[0] ?? 'token', scope });
        return print(`${created.token}\n(shown once; scope: ${scope})`, created);
      }
      if (sub === 'revoke' && rest[0]) {
        await c.request('DELETE', `/api/v1/tokens/${encodeURIComponent(rest[0])}`);
        return print('revoked', { ok: true });
      }
      const tokens = await c.request<Record<string, unknown>[]>('GET', '/api/v1/tokens');
      return print(
        table(tokens.map((t) => ({ ...t, createdAt: new Date(Number(t.createdAt)).toLocaleString(), lastUsedAt: t.lastUsedAt ? new Date(Number(t.lastUsedAt)).toLocaleString() : '' }))),
        tokens,
      );
    }
    case 'mcp': {
      const c = client();
      const me = await c.request<{ token: { name: string; scope: TokenScope } }>('GET', '/api/v1/auth/me');
      await serveMcpStdio({ api: c, scope: me.token.scope, clientName: me.token.name, version: VERSION });
      return;
    }
    default:
      throw new ApiError(400, 'INVALID_PARAMS', `Unknown command "${cmd}"`, 'Run "livynq help"');
  }
}

run().catch((err: unknown) => {
  const e = err instanceof ApiError ? err : { code: (err as { code?: string }).code ?? 'ERROR', message: err instanceof Error ? err.message : String(err), hint: undefined };
  if (asJson) process.stdout.write(`${JSON.stringify({ error: { code: e.code, message: e.message, hint: e.hint } })}\n`);
  else process.stderr.write(`error: ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ''}\n`);
  process.exit(e.code === 'UNREACHABLE' ? 3 : e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN' ? 4 : e.code === 'NOT_FOUND' ? 5 : 1);
});
