import { Badge, Card, PageHeader } from '../components/ui.tsx';
import { useT, type MessageKey } from '../lib/i18n.ts';

/** Prototype screens without backend support yet: same look, honest "coming soon" content. */
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
