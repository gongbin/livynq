import { useEffect, useState } from 'react';
import { errorMessage } from '../lib/api.ts';
import { assistantApi, type AssistantSettings, type LlmPreset } from '../lib/assistant.ts';
import { useT, type MessageKey } from '../lib/i18n.ts';
import { useCan } from '../lib/session.ts';
import { Icon } from './icons.tsx';
import { toast } from './toast.tsx';
import { Badge, Button, Card, ErrorNote, SectionLabel, SelectField, TextField } from './ui.tsx';

const CUSTOM = 'custom';

/** Settings → Assistant: model provider, API base URL, key and model. Admins only. */
export function AssistantSettingsCard() {
  const t = useT();
  const canAdmin = useCan('admin');
  const [current, setCurrent] = useState<AssistantSettings | null>(null);
  const [preset, setPreset] = useState<string>('claude');
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; reply?: string; error?: string; ms: number } | null>(null);

  const apply = (s: AssistantSettings) => {
    setCurrent(s);
    if (s.model) {
      setPreset(s.preset ?? CUSTOM);
      setProvider(s.provider ?? 'openai');
      setBaseUrl(s.baseUrl ?? '');
      setModel(s.model);
    }
  };
  useEffect(() => {
    assistantApi.settings().then(apply, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const choosePreset = (id: string) => {
    setPreset(id);
    setTest(null);
    const p = current?.presets.find((x) => x.id === id);
    if (!p) return;
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
  };
  const presetInfo: LlmPreset | undefined = current?.presets.find((p) => p.id === preset);
  const keyNeeded = preset === CUSTOM ? provider === 'anthropic' : (presetInfo?.needsKey ?? true);
  const ready = model.trim() && baseUrl.trim() && (!keyNeeded || apiKey.trim() || current?.hasKey);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      apply(await assistantApi.save({ provider, model: model.trim(), baseUrl: baseUrl.trim(), preset, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }));
      setApiKey('');
      toast(t('asst.saved'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(await assistantApi.test({ provider, model: model.trim(), baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }));
    } catch (e) {
      setTest({ ok: false, error: errorMessage(e), ms: 0 });
    } finally {
      setBusy(null);
    }
  };
  const clearKey = async () => {
    if (!current?.model) return;
    try {
      apply(await assistantApi.save({ provider, model: model.trim() || current.model, baseUrl: baseUrl.trim(), preset, apiKey: null }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionLabel>{t('asst.settings')}</SectionLabel>
          <p className="mt-1.5 mb-0 text-[13px] leading-relaxed text-pretty text-muted">{t('asst.settingsBody')}</p>
        </div>
        {current && <Badge tone={current.configured ? 'ok' : 'chip'}>{current.configured ? t('asst.ready') : t('asst.notSet')}</Badge>}
      </div>
      {!canAdmin ? (
        <p className="m-0 text-[13px] text-muted">{current?.configured ? t('asst.usingModel', { model: current.model ?? '' }) : t('asst.adminOnly')}</p>
      ) : !current ? null : (
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void save();
          }}
        >
          <SelectField
            label={t('asst.provider')}
            value={preset}
            onChange={choosePreset}
            options={[...current.presets.map((p) => ({ value: p.id, label: t(`asst.preset.${p.id}` as MessageKey) })), { value: CUSTOM, label: t('asst.preset.custom') }]}
          />
          {preset === CUSTOM && (
            <SelectField
              label={t('asst.protocol')}
              value={provider}
              onChange={(v) => setProvider(v as 'anthropic' | 'openai')}
              options={[
                { value: 'openai', label: t('asst.protocol.openai') },
                { value: 'anthropic', label: t('asst.protocol.anthropic') },
              ]}
            />
          )}
          <TextField label={t('asst.baseUrl')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} autoCapitalize="off" className="[&_input]:font-mono [&_input]:text-[13px]" />
          <TextField
            label={keyNeeded ? t('asst.apiKey') : t('asst.apiKeyOptional')}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={current.hasKey ? t('asst.keySaved') : 'sk-…'}
            autoComplete="off"
            hint={
              current.hasKey ? (
                <span>
                  {t('asst.keyHint')}{' '}
                  <button type="button" className="border-0 bg-transparent p-0 font-bold text-ink underline" onClick={() => void clearKey()}>
                    {t('asst.clearKey')}
                  </button>
                </span>
              ) : (
                t('asst.keyHintNew')
              )
            }
          />
          <TextField label={t('asst.model')} value={model} onChange={(e) => setModel(e.target.value)} placeholder={presetInfo?.model ?? 'model-name'} hint={t('asst.modelHint')} spellCheck={false} autoCapitalize="off" className="[&_input]:font-mono [&_input]:text-[13px]" />
          {error && <ErrorNote>{error}</ErrorNote>}
          {test && (
            <div className={test.ok ? 'flex items-start gap-2 rounded-[14px] bg-ok-soft px-3.5 py-3 text-[13px]' : 'flex items-start gap-2 rounded-[14px] bg-alert-soft px-3.5 py-3 text-[13px] text-alert'}>
              <Icon name={test.ok ? 'circleCheck' : 'alert'} size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{test.ok ? t('asst.testOk', { ms: test.ms, reply: test.reply ?? '' }) : test.error}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="amber" icon="check" busy={busy === 'save'} disabled={!ready || busy !== null}>
              {t('common.save')}
            </Button>
            <Button icon="activity" busy={busy === 'test'} disabled={!model.trim() || busy !== null} onClick={() => void runTest()}>
              {t('asst.test')}
            </Button>
          </div>
          <p className="m-0 text-xs leading-relaxed text-pretty text-muted">{t('asst.privacy')}</p>
        </form>
      )}
    </Card>
  );
}
