import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './icons.tsx';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ---------------------------------------------------------------- layout

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-[26px] leading-tight font-extrabold tracking-[-0.025em] md:text-[34px]">{title}</h1>
        {subtitle && <p className="mt-1.5 mb-0 text-sm text-pretty text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' }) {
  return <As className={cx('rounded-card border border-line bg-surface p-4 shadow-card md:p-[22px]', className)}>{children}</As>;
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-xs font-extrabold tracking-[0.06em] text-muted uppercase', className)}>{children}</div>;
}

export function Badge({ children, tone = 'chip', className }: { children: ReactNode; tone?: 'chip' | 'ok' | 'amber' | 'alert'; className?: string }) {
  const tones = {
    chip: 'bg-chip text-ink',
    ok: 'bg-ok-soft text-ink',
    amber: 'bg-amber-soft text-ink',
    alert: 'bg-alert-soft text-alert',
  };
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function Dot({ tone }: { tone: 'ok' | 'alert' | 'muted' | 'amber' }) {
  const c = { ok: 'bg-ok', alert: 'bg-alert', muted: 'bg-muted', amber: 'bg-amber' }[tone];
  return <span className={cx('inline-block size-[7px] shrink-0 rounded-full', c)} aria-hidden="true" />;
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Icon name="loader" size={size} className={cx('lv-spin', className)} />;
}

// ---------------------------------------------------------------- controls

type ButtonVariant = 'primary' | 'amber' | 'chip' | 'ghost' | 'danger';

export function Button({
  variant = 'chip',
  icon,
  busy,
  children,
  className,
  size = 'md',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: IconName; busy?: boolean; size?: 'sm' | 'md'; ref?: Ref<HTMLButtonElement> }) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-ink text-bg hover:opacity-90',
    amber: 'bg-amber text-on-amber hover:brightness-105',
    chip: 'bg-chip text-ink hover:bg-line',
    ghost: 'bg-transparent text-muted hover:bg-chip hover:text-ink',
    danger: 'bg-alert-soft text-alert hover:bg-alert hover:text-white',
  };
  const sizes = { sm: 'min-h-8 px-3 py-1.5 text-[13px] rounded-[10px]', md: 'min-h-10 px-4 py-2.5 text-sm rounded-ctl' };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 border-0 font-bold transition-[background-color,opacity,color,filter] duration-base disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {busy ? <Spinner size={15} /> : icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        'grid size-10 shrink-0 place-items-center rounded-ctl border-0 bg-chip text-ink transition-colors duration-base hover:bg-line disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

/** Pill switch from the prototype (40×22). `pending` shows a spinner on the knob. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  pending,
  size = 'md',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  pending?: boolean;
  size?: 'md' | 'lg';
}) {
  const lg = size === 'lg';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={pending || undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!pending) onChange(!checked);
      }}
      className="shrink-0 border-0 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <SwitchTrack checked={checked} pending={pending} size={size} />
    </button>
  );
}

/** The visual part of a switch, for use inside a larger clickable row. */
export function SwitchTrack({ checked, pending, size = 'md' }: { checked: boolean; pending?: boolean; size?: 'md' | 'lg' }) {
  const lg = size === 'lg';
  return (
    <span
      aria-hidden="true"
      className={cx('relative block shrink-0 rounded-full transition-colors duration-base', lg ? 'h-7 w-12' : 'h-[22px] w-10', checked ? 'bg-amber' : 'bg-chip', pending && 'opacity-70')}
    >
      <span
        className={cx(
          'absolute grid place-items-center rounded-full bg-surface text-muted shadow-[0_1px_2px_#0003] transition-transform duration-base ease-out-soft',
          lg ? 'top-1 left-1 size-5' : 'top-[3px] left-[3px] size-4',
        )}
        style={{ transform: `translateX(${checked ? (lg ? 20 : 18) : 0}px)` }}
      >
        {pending && <Spinner size={lg ? 13 : 11} />}
      </span>
    </span>
  );
}

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
  hint?: ReactNode;
  title?: string;
}

/** Segmented control (chip track, raised surface for the selected option). */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  className,
}: {
  value: V;
  options: SegmentOption<V>[];
  onChange: (v: V) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('flex gap-[3px] rounded-[13px] bg-chip p-1', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            title={typeof o.hint === 'string' ? o.hint : o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border-0 font-bold whitespace-nowrap transition-[background-color,color,box-shadow] duration-base disabled:cursor-not-allowed',
              size === 'sm' ? 'min-h-8 px-2.5 py-1.5 text-xs' : 'min-h-9 px-3 py-2 text-[13px]',
              on ? 'bg-surface text-ink shadow-card' : 'bg-transparent text-muted hover:text-ink disabled:hover:text-muted',
              o.disabled && 'opacity-60',
            )}
          >
            {o.icon && <Icon name={o.icon} size={size === 'sm' ? 14 : 15} />}
            {o.label}
            {o.hint && typeof o.hint !== 'string' && o.hint}
          </button>
        );
      })}
    </div>
  );
}

export function TextField({ label, hint, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-bold">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        className="min-h-11 rounded-ctl border border-line bg-surface px-3.5 text-sm text-ink transition-colors duration-base outline-none placeholder:text-muted focus:border-amber-ink"
      />
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-bold">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-11 w-full appearance-none rounded-ctl border border-line bg-surface py-2 pr-9 pl-3.5 text-sm text-ink outline-none focus:border-amber-ink disabled:opacity-60"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
      </div>
    </div>
  );
}

/** Two-step destructive button: first click arms it, second confirms. Disarms after 4s. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  icon = 'trash',
  size = 'md',
  busy,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  icon?: IconName;
  size?: 'sm' | 'md';
  busy?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      variant={armed ? 'danger' : 'chip'}
      size={size}
      icon={icon}
      busy={busy}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      className={armed ? 'bg-alert! text-white!' : undefined}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

export function CopyButton({ text, label, copiedLabel, variant = 'primary', size = 'md' }: { text: string; label: string; copiedLabel: string; variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      variant={variant}
      size={size}
      icon={copied ? 'check' : 'copy'}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </Button>
  );
}

/** Clipboard API needs a secure context; LAN hubs are often plain http, so fall back to execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function EmptyState({ icon, title, body, children }: { icon: IconName; title: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid size-14 place-items-center rounded-tile bg-chip text-muted">
        <Icon name={icon} size={24} />
      </span>
      <div className="text-base font-extrabold">{title}</div>
      {body && <p className="m-0 max-w-md text-sm leading-relaxed text-pretty text-muted">{body}</p>}
      {children}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-[14px] bg-alert-soft px-3.5 py-3 text-[13px] leading-normal">
      <Icon name="alert" size={17} className="mt-px shrink-0 text-alert" />
      <span>{children}</span>
    </div>
  );
}
