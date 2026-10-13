import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DeviceDTO, HomeKitBridgeInfo } from '@livynq/model';
import { renderSVG } from 'uqr';
import { Icon } from '../components/icons.tsx';
import { toast } from '../components/toast.tsx';
import { Badge, Card, ErrorNote, PageHeader, SectionLabel, Segmented, Spinner } from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { describe, roomName, sortDevices } from '../lib/devices.ts';
import { formatPincode } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { useCan } from '../lib/session.ts';

type HomeKitState = { enabled: boolean; bridges: HomeKitBridgeInfo[] };

export function EcosystemsPage() {
  const t = useT();
  const [hk, setHk] = useState<HomeKitState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.homekit().then(
        (d) => !cancelled && (setHk(d), setError(null)),
        (e: unknown) => !cancelled && setError(errorMessage(e)),
      );
    void load();
    // Pairing status changes when someone scans the code; poll gently while the page is open.
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <PageHeader title={t('eco.title')} subtitle={t('eco.subtitle')} />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {hk === null && !error ? (
          <Card className="grid min-h-60 place-items-center text-muted">
            <Spinner size={20} />
          </Card>
        ) : hk && !hk.enabled ? (
          <HomeKitDisabled />
        ) : hk && hk.bridges.length === 0 ? (
          <HomeKitDisabled noBridges />
        ) : (
          hk?.bridges.map((b) => <BridgeCard key={b.id} bridge={b} />)
        )}
        <MatterCard />
      </div>
      <ExposureList homekitEnabled={hk?.enabled ?? true} />
    </>
  );
}

function CardTitle({ icon, title, subtitle, badge }: { icon: Parameters<typeof Icon>[0]['name']; title: string; subtitle: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-[38px] shrink-0 place-items-center rounded-ctl bg-chip">
          <Icon name={icon} size={18} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-base font-extrabold">{title}</div>
          <div className="truncate text-xs text-muted">{subtitle}</div>
        </div>
      </div>
      {badge}
    </div>
  );
}

function BridgeCard({ bridge }: { bridge: HomeKitBridgeInfo }) {
  const t = useT();
  const svg = useMemo(() => renderSVG(bridge.setupURI, { border: 1, pixelSize: 6, whiteColor: '#ffffff', blackColor: '#1f1a14' }), [bridge.setupURI]);
  const steps = [t('eco.homekit.step1'), t('eco.homekit.step2'), t('eco.homekit.step3')];
  return (
    <Card className="flex flex-col gap-4">
      <CardTitle
        icon="home"
        title="Apple Home"
        subtitle={`HAP · ${bridge.name}`}
        badge={<Badge tone={bridge.paired ? 'ok' : 'amber'}>{bridge.paired ? t('eco.homekit.paired') : t('eco.homekit.notPaired')}</Badge>}
      />
      <div className="flex flex-wrap items-center gap-4">
        {/* QR codes need a light background to scan reliably, also in dark mode. */}
        <div
          role="img"
          aria-label={t('eco.homekit.qr')}
          className="size-[132px] shrink-0 overflow-hidden rounded-[14px] border border-line bg-white p-1.5 [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="flex flex-col gap-1">
          <div className="text-xs text-muted">{t('eco.homekit.code')}</div>
          <div className="font-mono text-[22px] font-bold tracking-[0.04em]">{formatPincode(bridge.pincode)}</div>
          <div className="text-xs text-muted">
            {t('eco.homekit.port')} {bridge.port}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between text-[13px]">
          <span className="font-semibold">{t('eco.homekit.accessories')}</span>
          <span className="font-mono text-xs text-muted">{bridge.accessoryCount} / 149</span>
        </div>
        <div className="h-1.5 rounded-full bg-chip">
          <div className="h-full rounded-full bg-amber transition-[width] duration-slow" style={{ width: `${Math.min(100, (bridge.accessoryCount / 149) * 100)}%` }} />
        </div>
      </div>
      {!bridge.paired && (
        <ol className="m-0 flex list-none flex-col gap-2 border-t border-line p-0 pt-3">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2.5 text-[13.5px]">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-soft font-mono text-[11px] font-bold text-amber-ink">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function HomeKitDisabled({ noBridges }: { noBridges?: boolean }) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-4">
      <CardTitle icon="home" title="Apple Home" subtitle="HAP" badge={<Badge>{noBridges ? '—' : t('settings.disabled')}</Badge>} />
      <div className="flex gap-4">
        <div className="grid size-[108px] shrink-0 place-items-center rounded-[14px] border border-line bg-[repeating-linear-gradient(45deg,var(--chip)_0_6px,var(--surface)_6px_12px)] text-muted">
          <Icon name="home" size={22} />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-[15px] font-extrabold">{noBridges ? t('eco.homekit.noBridges') : t('eco.homekit.disabled')}</div>
          {!noBridges && <p className="m-0 text-[13px] leading-relaxed text-muted">{t('eco.homekit.disabledBody')}</p>}
        </div>
      </div>
    </Card>
  );
}

function MatterCard() {
  const t = useT();
  return (
    <Card className="flex flex-col gap-4">
      <CardTitle icon="share" title="Matter" subtitle="Controller + Bridge" badge={<Badge tone="amber">{t('common.soon')}</Badge>} />
      <div className="flex flex-col gap-2 opacity-70">
        <SectionLabel>Fabrics</SectionLabel>
        {['Apple Home', 'Google Home', 'Livynq Controller'].map((name) => (
          <div key={name} className="flex items-center justify-between rounded-[13px] bg-chip px-3 py-[11px] text-[13.5px]">
            <span className="font-bold">{name}</span>
            <span className="h-2 w-16 rounded-full bg-line" aria-hidden="true" />
          </div>
        ))}
      </div>
      <p className="m-0 text-[13px] leading-relaxed text-muted">{t('eco.matter.body')}</p>
    </Card>
  );
}

function ExposureList({ homekitEnabled }: { homekitEnabled: boolean }) {
  const t = useT();
  const { devices, rooms } = useLive();
  const canAdmin = useCan('admin');
  const [busy, setBusy] = useState<string | null>(null);
  const list = sortDevices(Object.values(devices));

  const set = (d: DeviceDTO, homekit: boolean) => {
    if (homekit === d.exposure.homekit) return;
    setBusy(d.id);
    api.updateDevice(d.id, { exposure: { ...d.exposure, homekit } }).then(
      () => setBusy(null),
      (e: unknown) => {
        setBusy(null);
        toast(errorMessage(e), 'error');
      },
    );
  };

  return (
    <Card className="flex flex-col gap-1">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2.5">
        <SectionLabel>{t('eco.exposure')}</SectionLabel>
        <div className="text-xs text-muted">{homekitEnabled ? t('eco.exposureHint') : t('eco.homekit.disabled')}</div>
      </div>
      {list.map((d) => {
        const v = describe(d, t);
        return (
          <div key={d.id} className="flex flex-wrap items-center gap-3 border-t border-line py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-chip text-muted">
              <Icon name={v.icon} size={15} />
            </span>
            <div className="min-w-[120px] flex-1">
              <div className="text-sm font-bold">{d.name}</div>
              <div className="text-xs text-muted">{[roomName(d, rooms), d.protocol].filter(Boolean).join(' · ')}</div>
            </div>
            {busy === d.id && <Spinner size={14} className="text-muted" />}
            <Segmented
              size="sm"
              label={`${d.name}: ${t('dev.exposeHomekit')}`}
              value={d.exposure.homekit ? 'hap' : 'off'}
              onChange={(v) => canAdmin && busy !== d.id && set(d, v === 'hap')}
              options={[
                { value: 'hap', label: 'HAP', disabled: !canAdmin },
                { value: 'matter', label: 'Matter', disabled: true, hint: t('common.soon') },
                { value: 'off', label: t('common.off'), disabled: !canAdmin },
              ]}
            />
          </div>
        );
      })}
    </Card>
  );
}
