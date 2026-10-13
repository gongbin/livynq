import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n.ts';
import { createStore, useStore } from '../lib/store.ts';
import { Icon, type IconName } from './icons.tsx';
import { Button } from './ui.tsx';

interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  icon?: IconName;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const current = createStore<ConfirmRequest | null>(null);

/** In-app confirmation (never `window.confirm`: kiosk browsers often block it). */
export function confirmDialog(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  current.get()?.resolve(false);
  return new Promise((resolve) => current.set({ ...req, resolve }));
}

function close(ok: boolean): void {
  const req = current.get();
  current.set(null);
  req?.resolve(ok);
}

/** Mounted once at the app root. */
export function DialogHost() {
  const t = useT();
  const req = useStore(current);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!req) return;
    const previous = document.activeElement as HTMLElement | null;
    // Focus the safe choice first.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [req]);

  if (!req) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-overlay" onClick={() => close(false)} aria-hidden="true" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lv-dialog-title"
        aria-describedby={req.body ? 'lv-dialog-body' : undefined}
        className="relative flex w-full max-w-sm animate-sheet-up flex-col gap-4 rounded-panel bg-surface p-6 text-ink shadow-sheet"
      >
        {req.icon && (
          <span className={req.danger ? 'grid size-12 place-items-center rounded-tile bg-alert-soft text-alert' : 'grid size-12 place-items-center rounded-tile bg-amber-soft text-amber-ink'}>
            <Icon name={req.icon} size={22} />
          </span>
        )}
        <div className="flex flex-col gap-1.5">
          <h2 id="lv-dialog-title" className="m-0 text-lg leading-snug font-extrabold tracking-[-0.01em]">
            {req.title}
          </h2>
          {req.body && (
            <p id="lv-dialog-body" className="m-0 text-sm leading-relaxed text-muted">
              {req.body}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant={req.danger ? 'danger' : 'primary'} className={req.danger ? 'bg-alert! text-white! hover:brightness-110' : undefined} onClick={() => close(true)}>
            {req.confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
