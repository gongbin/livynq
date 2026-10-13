import { Icon, type IconName } from '../components/icons.tsx';
import { Badge, Card, PageHeader } from '../components/ui.tsx';
import { useT, type MessageKey } from '../lib/i18n.ts';

/** Prototype screens without M0 backend support: same look, honest "coming soon" content. */
function SoonCard({ icon, title, body, features }: { icon: IconName; title: MessageKey; body: MessageKey; features?: { icon: IconName; label: string }[] }) {
  const t = useT();
  return (
    <Card className="flex flex-col items-start gap-4">
      <div className="flex w-full items-start justify-between gap-3">
        <span className="grid size-12 place-items-center rounded-tile bg-amber text-on-amber">
          <Icon name={icon} size={22} />
        </span>
        <Badge tone="amber">{t('common.soon')}</Badge>
      </div>
      <div>
        <div className="text-[17px] font-extrabold">{t(title)}</div>
        <p className="mt-1.5 mb-0 max-w-xl text-sm leading-relaxed text-pretty text-muted">{t(body)}</p>
      </div>
      {features && (
        <div className="grid w-full gap-2.5 sm:grid-cols-3">
          {features.map((f) => (
            <div key={f.label} className="flex items-center gap-2.5 rounded-tile bg-chip px-3.5 py-3 text-[13.5px] font-bold">
              <Icon name={f.icon} size={16} className="text-muted" />
              {f.label}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function AutomationsPage() {
  const t = useT();
  return (
    <>
      <PageHeader title={t('auto.title')} subtitle={t('auto.subtitle')} />
      <SoonCard
        icon="workflow"
        title="auto.soonTitle"
        body="auto.soonBody"
        features={[
          { icon: 'workflow', label: t('auto.f1') },
          { icon: 'activity', label: t('auto.f2') },
          { icon: 'sparkles', label: t('auto.f3') },
        ]}
      />
    </>
  );
}

export function MigratePage() {
  const t = useT();
  const steps: MessageKey[] = ['migrate.step.scan', 'migrate.step.report', 'migrate.step.apply', 'migrate.step.verify'];
  const sources: [string, MessageKey][] = [
    ['Home Assistant', 'migrate.ha'],
    ['Homebridge', 'migrate.homebridge'],
    ['Zigbee2MQTT', 'migrate.z2m'],
    ['zwave-js-ui', 'migrate.zwave'],
  ];
  return (
    <>
      <PageHeader title={t('migrate.title')} subtitle={t('migrate.subtitle')} />
      <div className="grid grid-cols-4 gap-2" aria-hidden="true">
        {steps.map((s, i) => (
          <div key={s} className="flex flex-col gap-2">
            <div className={i === 0 ? 'h-1 rounded-full bg-amber' : 'h-1 rounded-full bg-chip'} />
            <div className={i === 0 ? 'flex items-center gap-1.5 text-[13px] font-bold' : 'flex items-center gap-1.5 text-[13px] font-bold text-muted'}>
              <span className="font-mono text-[11px]">0{i + 1}</span>
              {t(s)}
            </div>
          </div>
        ))}
      </div>
      <Card className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[17px] font-extrabold">{t('migrate.from')}</div>
          <Badge tone="amber">{t('common.soon')}</Badge>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
          {sources.map(([name, desc]) => (
            <div key={name} className="flex flex-col gap-1.5 rounded-tile border-[1.5px] border-line p-4 opacity-75">
              <span className="text-[15px] font-extrabold">{name}</span>
              <span className="text-[12.5px] leading-snug text-muted">{t(desc)}</span>
            </div>
          ))}
        </div>
        <p className="m-0 text-sm text-muted">{t('migrate.soonBody')}</p>
      </Card>
    </>
  );
}
