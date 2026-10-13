import { useEffect, useState, type ReactNode } from 'react';
import type { DeviceDTO, ExposurePolicy } from '@livynq/model';
import { api, errorMessage, type DevicePatch } from '../lib/api.ts';
import { attr, describe, readings, roomName } from '../lib/devices.ts';
import { useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { useCan } from '../lib/session.ts';
import { BrightnessSlider, ColorTempSlider, HuePicker, useCommand, usePending } from './device-controls.tsx';
import { toneStyle } from './device-card.tsx';
import { HistoryStrip } from './history.tsx';
import { Icon } from './icons.tsx';
import { Sheet } from './sheet.tsx';
import { toast } from './toast.tsx';
import { Button, ConfirmButton, IconButton, SectionLabel, Segmented, SelectField, Switch, SwitchTrack, TextField, cx } from './ui.tsx';

export function DeviceSheet({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const { devices } = useLive();
  const device = devices[deviceId];
  // Close if the device disappears (deleted here or elsewhere).
  useEffect(() => {
    if (!device) onClose();
  }, [device, onClose]);
  if (!device) return null;
  return (
    <Sheet label={device.name} onClose={onClose}>
      <SheetBody device={device} onClose={onClose} />
    </Sheet>
  );
}

function SheetBody({ device, onClose }: { device: DeviceDTO; onClose: () => void }) {
  const t = useT();
  const { rooms } = useLive();
  const run = useCommand();
  const v = describe(device, t);
  const style = toneStyle(v);
  const room = roomName(device, rooms);
  const offline = device.availability === 'offline';
  const canControl = useCan('control');
  const powerPending = usePending(device.id, v.toggleEndpoint, 'onOff');
  const assumed = device.endpoints.some((e) => e.assumedState);

  return (
    <>
      <div className="flex items-start gap-3.5">
        <span className="grid size-[52px] shrink-0 place-items-center rounded-tile transition-colors duration-slow" style={style.icon}>
          <Icon name={v.icon} size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-xl font-extrabold tracking-[-0.02em] break-words">{device.name}</h2>
          <div className="mt-0.5 text-[13px] text-muted">
            {room ? `${room} · ` : ''}
            {v.stateText}
          </div>
        </div>
        <IconButton icon="x" label={t('common.close')} onClick={onClose} />
      </div>

      {offline && (
        <div className="flex items-center gap-2.5 rounded-[14px] bg-chip px-3.5 py-3 text-[13px] text-muted">
          <Icon name="wifiOff" size={16} className="shrink-0" />
          {t('common.offline')}
        </div>
      )}

      {v.toggleEndpoint !== undefined && (
        <button
          type="button"
          role="switch"
          aria-checked={v.on}
          aria-busy={powerPending || undefined}
          disabled={offline || !canControl}
          onClick={() => !powerPending && void run(device.id, v.toggleEndpoint!, 'onOff', v.on ? 'off' : 'on')}
          className="flex items-center justify-between rounded-tile border border-line bg-surface px-4 py-3.5 text-[15px] font-bold text-ink transition-[background-color,border-color] duration-slow disabled:cursor-not-allowed disabled:opacity-60"
          style={style.card}
        >
          <span className="flex items-center gap-2">
            {v.on ? t('common.on') : t('common.off')}
            {powerPending && <span className="text-xs font-semibold text-muted">{t('common.pending')}</span>}
          </span>
          <SwitchTrack checked={v.on ?? false} pending={powerPending} size="lg" />
        </button>
      )}

      {v.light && (v.light.percent !== undefined || v.light.hasColorTemp) && canControl && (
        <div className="flex flex-col gap-4">
          {v.light.percent !== undefined && <BrightnessSlider device={device} light={v.light} />}
          {v.light.hasColorTemp && <ColorTempSlider device={device} light={v.light} />}
          {v.light.hasHue && <HuePicker device={device} light={v.light} />}
        </div>
      )}

      {assumed && <p className="m-0 text-xs text-muted">{t('dev.assumed')}</p>}

      <ReadingTiles device={device} />
      <HistoryStrip device={device} />
      <SettingsSection device={device} />
      <DetailsSection device={device} />
    </>
  );
}

function ReadingTiles({ device }: { device: DeviceDTO }) {
  const t = useT();
  const tiles: { key: string; icon: Parameters<typeof Icon>[0]['name']; label: string; value: string; alert?: boolean }[] = readings(device).map((r) => ({
    key: `${r.endpointId}/${r.capability}`,
    icon: r.icon,
    label: t(r.label),
    value: r.text,
    alert: r.capability === 'powerSource' && r.value <= 20,
  }));
  const occ = attr(device, 'occupancySensing', 'occupied');
  if (typeof occ === 'boolean') tiles.push({ key: 'occ', icon: 'motion', label: t('dev.motion'), value: occ ? t('state.detected') : t('state.clear') });
  const bool = attr(device, 'booleanState', 'stateValue');
  if (typeof bool === 'boolean') {
    const leak = device.endpoints.some((e) => e.deviceType === 'binarySensor.leak');
    tiles.push(
      leak
        ? { key: 'leak', icon: 'droplet', label: t('dev.leak'), value: bool ? t('state.leak') : t('state.dry'), alert: bool }
        : { key: 'contact', icon: bool ? 'door' : 'doorOpen', label: t('dev.contact'), value: bool ? t('state.closed') : t('state.open') },
    );
  }
  if (!tiles.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {tiles.map((x) => (
        <div key={x.key} className={cx('flex flex-col gap-1 rounded-tile p-3.5', x.alert ? 'bg-alert-soft' : 'bg-chip')}>
          <span className="flex items-center gap-1.5 text-xs font-bold text-muted">
            <Icon name={x.icon} size={14} />
            {x.label}
          </span>
          <span className={cx('text-[22px] font-light tracking-[-0.03em]', x.alert && 'text-alert')}>{x.value}</span>
        </div>
      ))}
    </div>
  );
}

function useDevicePatch(device: DeviceDTO) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const patch = async (what: string, body: DevicePatch) => {
    setBusy(what);
    try {
      await api.updateDevice(device.id, body);
      return true;
    } catch (err) {
      toast(errorMessage(err) || t('common.error'), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, patch };
}

function SettingsSection({ device }: { device: DeviceDTO }) {
  const t = useT();
  const { rooms } = useLive();
  const canAdmin = useCan('admin');
  const { busy, patch } = useDevicePatch(device);
  const [name, setName] = useState(device.name);
  const [aliases, setAliases] = useState(device.aliases.join(', '));
  // Re-sync when the device changes elsewhere (another tab, an agent).
  useEffect(() => setName(device.name), [device.name]);
  useEffect(() => setAliases(device.aliases.join(', ')), [device.aliases]);
  const parsedAliases = aliases
    .split(/[,，]/)
    .map((a) => a.trim())
    .filter(Boolean);
  const dirty = name.trim() !== device.name || parsedAliases.join('\u0000') !== device.aliases.join('\u0000');
  const setExposure = (e: Partial<ExposurePolicy>) => void patch('exposure', { exposure: { ...device.exposure, ...e } });

  return (
    <Section title={t('dev.settings')}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty || !name.trim()) return;
          void patch('form', { name: name.trim(), aliases: parsedAliases }).then((ok) => ok && toast(t('common.saved')));
        }}
      >
        <TextField label={t('dev.name')} value={name} onChange={(e) => setName(e.target.value)} disabled={!canAdmin} maxLength={120} />
        <TextField label={t('dev.aliases')} hint={t('dev.aliasesHint')} value={aliases} onChange={(e) => setAliases(e.target.value)} disabled={!canAdmin} />
        {dirty && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={() => {
                setName(device.name);
                setAliases(device.aliases.join(', '));
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" type="submit" busy={busy === 'form'} disabled={!name.trim()}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </form>
      <SelectField
        label={t('dev.room')}
        value={device.roomId ?? ''}
        disabled={!canAdmin || busy === 'room'}
        onChange={(v) => void patch('room', { roomId: v || null })}
        options={[{ value: '', label: t('dev.noRoom') }, ...rooms.map((r) => ({ value: r.id, label: r.name }))]}
      />
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="flex items-center gap-2 text-sm font-bold">
          <Icon name="home" size={16} className="text-muted" />
          {t('dev.exposeHomekit')}
        </span>
        <Switch checked={device.exposure.homekit} pending={busy === 'exposure'} disabled={!canAdmin} label={t('dev.exposeHomekit')} onChange={(homekit) => setExposure({ homekit })} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-sm font-bold">
          <Icon name="bot" size={16} className="text-muted" />
          {t('dev.agentAccess')}
        </span>
        <Segmented
          label={t('dev.agentAccess')}
          size="sm"
          value={device.exposure.agent}
          onChange={(agent) => canAdmin && setExposure({ agent })}
          options={(['visible', 'readOnly', 'hidden'] as const).map((v) => ({ value: v, label: t(`dev.agent.${v}`), disabled: !canAdmin }))}
        />
      </div>
    </Section>
  );
}

function DetailsSection({ device }: { device: DeviceDTO }) {
  const t = useT();
  const canAdmin = useCan('admin');
  const [deleting, setDeleting] = useState(false);
  const info: [string, ReactNode, boolean?][] = [
    [t('dev.status'), device.availability === 'online' ? t('common.online') : device.availability === 'offline' ? t('common.offline') : t('common.unknown')],
    [t('dev.protocol'), device.protocol],
    [t('dev.adapter'), device.adapter],
    [t('dev.id'), device.id, true],
  ];
  if (device.info.manufacturer) info.push([t('dev.manufacturer'), device.info.manufacturer]);
  if (device.info.model) info.push([t('dev.model'), device.info.model]);
  if (device.info.firmware) info.push([t('dev.firmware'), device.info.firmware, true]);
  if (device.info.serial) info.push([t('dev.serial'), device.info.serial, true]);

  return (
    <Section title={t('dev.details')}>
      <div className="flex flex-col">
        <SectionLabel className="mb-1">{t('dev.entities')}</SectionLabel>
        {device.endpoints.map((ep) => (
          <InfoRow key={ep.id} k={ep.name ?? t('dev.endpoint', { n: ep.id })} v={device.entities[ep.id] ?? '—'} mono />
        ))}
      </div>
      <div className="flex flex-col">
        {info.map(([k, v, mono]) => (
          <InfoRow key={k} k={k} v={v} mono={mono} />
        ))}
      </div>
      <details className="group rounded-tile bg-chip">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-3 text-[13px] font-bold">
          {t('dev.rawState')}
          <Icon name="chevronDown" size={16} className="text-muted transition-transform duration-base group-open:rotate-180" />
        </summary>
        <pre className="m-0 overflow-x-auto px-3.5 pb-3.5 font-mono text-xs leading-relaxed">{JSON.stringify(device.state, null, 2)}</pre>
      </details>
      {canAdmin && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <p className="m-0 text-xs leading-relaxed text-muted">{t('dev.deleteBody')}</p>
          <div>
            <ConfirmButton
              label={t('dev.delete')}
              confirmLabel={t('common.confirmDelete')}
              busy={deleting}
              onConfirm={() => {
                setDeleting(true);
                api.deleteDevice(device.id).then(
                  () => toast(t('dev.deleted')),
                  (err: unknown) => {
                    setDeleting(false);
                    toast(errorMessage(err), 'error');
                  },
                );
              }}
            />
          </div>
        </div>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5 border-t border-line pt-5">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

function InfoRow({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-2.5 text-[13px]">
      <span className="shrink-0 text-muted">{k}</span>
      <span className={cx('min-w-0 text-right font-semibold break-all', mono && 'font-mono text-xs')}>{v}</span>
    </div>
  );
}
