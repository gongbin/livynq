import { createStore, useStore } from '../lib/store.ts';
import { Icon } from './icons.tsx';
import { cx } from './ui.tsx';

interface Toast {
  id: number;
  tone: 'error' | 'ok' | 'info';
  text: string;
}

const toasts = createStore<Toast[]>([]);
let seq = 0;

export function toast(text: string, tone: Toast['tone'] = 'ok'): void {
  const id = ++seq;
  toasts.set((list) => [...list.slice(-2), { id, tone, text }]);
  setTimeout(() => dismiss(id), tone === 'ok' ? 3000 : 6000);
}

function dismiss(id: number): void {
  toasts.set((list) => list.filter((t) => t.id !== id));
}

export function Toaster() {
  const list = useStore(toasts);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
    >
      {list.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={cx(
            'pointer-events-auto flex max-w-md animate-toast-in items-center gap-2.5 rounded-tile px-4 py-3 text-[13.5px] font-semibold shadow-sheet',
            t.tone === 'error' ? 'bg-alert text-white' : 'bg-ink text-bg',
          )}
        >
          <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'info' ? 'hourglass' : 'circleCheck'} size={17} className="shrink-0" />
          <span className="min-w-0 flex-1">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="-mr-1 grid size-7 place-items-center rounded-lg border-0 bg-transparent opacity-80 hover:opacity-100">
            <Icon name="x" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
