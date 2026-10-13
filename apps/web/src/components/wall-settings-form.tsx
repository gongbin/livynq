import { useEffect, useId, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import type { WallSettings } from '@livynq/model';
import { api, errorMessage, withToken } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useCan } from '../lib/session.ts';
import { wallDraft, wallSettings, useWallLook, useWallSettings } from '../lib/wall-settings.ts';
import { glassBackground } from './glass.tsx';
import { Icon } from './icons.tsx';
import { toast } from './toast.tsx';
import { Button, ConfirmButton, SectionLabel, Spinner, cx } from './ui.tsx';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 2560;
/** Below this size and edge length the original is uploaded untouched. */
const KEEP_BYTES = 3 * 1024 * 1024;

type SliderKey = 'cardOpacity' | 'backgroundBlur' | 'backgroundDim';

// ---------------------------------------------------------------- image preparation

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch {
      // fall back to <img> (older Safari)
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Wall tablets are often modest; a 6000px photo makes every repaint (blur!) expensive.
 * Scale down to 2560px on the long edge and re-encode as WebP (JPEG where WebP encoding
 * is unavailable). Anything that goes wrong falls back to the original file.
 */
export async function prepareImage(file: File): Promise<Blob> {
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
    if (scale === 1 && file.size <= KEEP_BYTES) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    let blob = await toBlob(canvas, 'image/webp', 0.86);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.88);
    if (!blob || !TYPES.includes(blob.type)) return file;
    return blob.size < file.size || file.size > MAX_BYTES ? blob : file;
  } catch {
    return file;
  } finally {
    decoded.done();
  }
}

// ---------------------------------------------------------------- preview

/** A miniature wall: the image with blur/dim and two glass cards, following the sliders live. */
export function WallPreview({ look, className }: { look: WallSettings; className?: string }) {
  const t = useT();
  const bg = look.background;
  // The preview is ~1/4 of a tablet, so scale the blur down to look the same.
  const blur = look.backgroundBlur / 4;
  const card = (active: boolean): CSSProperties => ({
    background: bg ? glassBackground(active ? 'var(--amber-soft)' : 'var(--surface)', look.cardOpacity) : active ? 'var(--amber-soft)' : 'var(--surface)',
  });
  return (
    <div
      className={cx('lv-dark relative isolate aspect-[16/10] overflow-hidden rounded-tile bg-bg text-ink', bg && 'lv-wall-glass', className)}
      role="img"
      aria-label={t('wall.preview')}
    >
      {bg && (
        <>
          <div
            className="absolute bg-cover bg-center transition-[filter] duration-base"
            style={{ backgroundImage: `url("${withToken(bg.url)}")`, filter: blur ? `blur(${blur}px)` : undefined, inset: -blur * 2 }}
          />
          <div className="absolute inset-0 transition-colors duration-base" style={{ background: `oklch(0 0 0 / ${look.backgroundDim})` }} />
        </>
      )}
      <div className="relative flex h-full flex-col justify-between p-[6%]">
        <div className="lv-shadow-text text-[30px] leading-none sm:text-[40px] font-light tracking-[-0.04em] tabular-nums">21:30</div>
        <div className="grid grid-cols-3 gap-[4%]">
          {[true, false, false].map((active, i) => (
            <div key={i} className={cx('flex flex-col gap-1 rounded-[10px] border border-line p-[8%]', bg && 'lv-glass')} style={card(active)}>
              <span className={cx('size-3.5 rounded-[5px]', active ? 'bg-amber' : 'bg-chip')} />
              <span className="mt-1 h-1.5 w-3/4 rounded-full bg-ink/80" />
              <span className="h-1.5 w-1/2 rounded-full bg-muted/70" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- form

function LookSlider({ label, value, min, max, step, format, disabled, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; disabled: boolean; onChange: (v: number) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[13px] font-bold">
        <label htmlFor={id}>{label}</label>
        <span className="font-mono">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="lv-range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={format(value)}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** Upload / remove the background and tune the glass. Used in Settings and in the wall's customize sheet. */
export function WallSettingsForm({ preview = true }: { preview?: boolean }) {
  const t = useT();
  const canAdmin = useCan('admin');
  const saved = useWallSettings();
  const look = useWallLook();
  const inputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ phase: 'preparing' | 'uploading'; progress: number; preview?: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const [removing, setRemoving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef<Partial<WallSettings>>({});

  // Drop any unsaved draft when leaving (e.g. the sheet closes mid-drag before the save lands).
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        flush();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function flush(): void {
    timer.current = undefined;
    const patch = latest.current as Pick<WallSettings, SliderKey>;
    latest.current = {};
    api.updateWallSettings(patch).then(
      (res) => {
        wallSettings.set(res.wall);
        if (timer.current === undefined) wallDraft.set(null);
      },
      (err: unknown) => {
        if (timer.current === undefined) wallDraft.set(null);
        toast(errorMessage(err), 'error');
      },
    );
  }

  const change = (key: SliderKey, value: number) => {
    latest.current = { ...latest.current, [key]: value };
    wallDraft.set((d) => ({ ...d, [key]: value }));
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 350);
  };

  const pick = async (file: File | undefined) => {
    if (!file || !canAdmin || upload) return;
    if (!TYPES.includes(file.type)) return toast(t('wall.badType'), 'error');
    const local = URL.createObjectURL(file);
    setUpload({ phase: 'preparing', progress: 0, preview: local });
    try {
      const blob = await prepareImage(file);
      if (blob.size > MAX_BYTES) throw new Error(t('wall.tooBig'));
      setUpload({ phase: 'uploading', progress: 0, preview: local });
      const res = await api.uploadWallBackground(blob, (p) => setUpload({ phase: 'uploading', progress: p, preview: local }));
      wallSettings.set(res.wall);
      toast(t('wall.uploaded'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      URL.revokeObjectURL(local);
      setUpload(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = () => {
    setRemoving(true);
    api.deleteWallBackground().then(
      (res) => {
        setRemoving(false);
        wallSettings.set(res.wall);
        toast(t('wall.removed'));
      },
      (err: unknown) => {
        setRemoving(false);
        toast(errorMessage(err), 'error');
      },
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void pick(e.dataTransfer.files[0]);
  };

  const bg = saved?.background ?? null;
  const thumb = upload?.preview ?? (bg ? withToken(bg.url) : undefined);
  const disabled = !canAdmin;

  return (
    <div className={cx('grid gap-5', preview && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')}>
      {preview && (
        <div className="flex flex-col gap-2">
          <SectionLabel>{t('wall.preview')}</SectionLabel>
          <WallPreview look={look} />
        </div>
      )}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <SectionLabel>{t('wall.background')}</SectionLabel>
          <input
            ref={inputRef}
            type="file"
            accept={TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            disabled={disabled}
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled || undefined}
            aria-label={bg ? t('wall.replace') : t('wall.upload')}
            onClick={() => !disabled && !upload && inputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !disabled && !upload) {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              if (disabled) return;
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={disabled ? undefined : onDrop}
            className={cx(
              'flex items-center gap-3.5 rounded-tile border-2 border-dashed p-3 transition-colors duration-base',
              drag ? 'border-amber-ink bg-amber-soft' : 'border-line',
              disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:border-wall/60',
            )}
          >
            <span className="relative grid size-[72px] shrink-0 place-items-center overflow-hidden rounded-ctl bg-chip text-muted">
              {thumb ? <img src={thumb} alt="" className="size-full object-cover" /> : <Icon name="image" size={24} />}
              {upload && (
                <span className="absolute inset-0 grid place-items-center bg-overlay text-white">
                  <Spinner size={20} />
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-1.5 text-sm font-bold">
                <Icon name="upload" size={15} />
                {upload
                  ? upload.phase === 'preparing'
                    ? t('wall.preparing')
                    : t('wall.uploading', { p: Math.round(upload.progress * 100) })
                  : bg
                    ? t('wall.replace')
                    : t('wall.drop')}
              </span>
              <span className="text-xs leading-normal text-muted">{bg || upload ? t('wall.formats') : `${t('wall.noBackground')} ${t('wall.formats')}`}</span>
              {upload?.phase === 'uploading' && (
                <span className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-chip">
                  <span className="block h-full rounded-full bg-amber transition-[width] duration-base" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
                </span>
              )}
            </span>
          </div>
          {bg && canAdmin && (
            <div>
              <ConfirmButton size="sm" label={t('wall.remove')} confirmLabel={t('wall.removeConfirm')} busy={removing} onConfirm={remove} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <LookSlider label={t('wall.cardOpacity')} value={look.cardOpacity} min={0.2} max={1} step={0.02} format={(v) => `${Math.round(v * 100)}%`} disabled={disabled} onChange={(v) => change('cardOpacity', v)} />
          <LookSlider label={t('wall.blur')} value={look.backgroundBlur} min={0} max={40} step={1} format={(v) => `${v} px`} disabled={disabled} onChange={(v) => change('backgroundBlur', v)} />
          <LookSlider label={t('wall.dim')} value={look.backgroundDim} min={0} max={0.9} step={0.05} format={(v) => `${Math.round(v * 100)}%`} disabled={disabled} onChange={(v) => change('backgroundDim', v)} />
          {!bg && <p className="m-0 text-xs text-muted">{t('wall.slidersHint')}</p>}
          {disabled && (
            <p className="m-0 flex items-center gap-1.5 text-xs text-muted">
              <Icon name="lock" size={13} />
              {t('wall.readOnly')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function OpenWallButton() {
  const t = useT();
  return (
    <Button size="sm" icon="tablet" onClick={() => (location.hash = '#/wall')}>
      {t('wall.open')}
    </Button>
  );
}
