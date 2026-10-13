import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createStore } from '../lib/store.ts';

/** How many sheets are open; overlays that must stay visible (approval banner) make room on wide screens. */
export const openSheets = createStore(0);

/**
 * Bottom sheet on phones, right-hand drawer on tablet/desktop (as in the prototype).
 * Closes on Escape and overlay click; focus moves into the sheet and returns afterwards.
 */
export function Sheet({ label, onClose, children, clearOverlay }: { label: string; onClose: () => void; children: ReactNode; clearOverlay?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    openSheets.set((n) => n + 1);
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab' && panel.current) trapFocus(e, panel.current);
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      openSheets.set((n) => n - 1);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-40">
      {/* clearOverlay: keep what is behind fully visible, e.g. to preview wall look changes live. */}
      <div className={clearOverlay ? 'absolute inset-0' : 'absolute inset-0 animate-fade-in bg-overlay'} onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] animate-sheet-up flex-col gap-5 overflow-y-auto overscroll-contain rounded-t-[26px] bg-surface p-[22px] pb-[max(22px,env(safe-area-inset-bottom))] text-ink shadow-sheet outline-none md:top-0 md:right-0 md:left-auto md:max-h-none md:w-[440px] md:animate-sheet-left md:rounded-t-none md:rounded-l-[26px]"
      >
        <div className="mx-auto -mt-2.5 -mb-2 h-1 w-10 shrink-0 rounded-full bg-line md:hidden" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

function trapFocus(e: KeyboardEvent, root: HTMLElement): void {
  const items = root.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea, summary, [tabindex]:not([tabindex="-1"])');
  if (!items.length) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
