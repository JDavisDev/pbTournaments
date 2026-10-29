'use client';

import Link from 'next/link';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

// Pill buttons: solid ink for the main action, outlined for the rest.
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-text hover:opacity-80',
  secondary: 'border border-border bg-surface hover:border-text',
  ghost: 'hover:bg-surface-2',
  danger: 'bg-late text-white hover:opacity-85',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: Variant; size?: 'sm' | 'md' }) {
  // 48px main buttons and 40px small ones: easy to hit, including with a tremor.
  const sizing = size === 'sm' ? 'h-10 px-4 text-sm' : 'h-12 px-6';
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${sizing} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function LinkButton({
  variant = 'secondary',
  className = '',
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return (
    <Link
      className={`inline-flex h-12 items-center justify-center gap-1.5 rounded-full px-6 font-medium transition ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/** A flat tile: gray on white, like a product card. */
export function Card({ className = '', ...props }: ComponentProps<'div'>) {
  return <div className={`rounded-2xl bg-surface-2 ${className}`} {...props} />;
}

const tones = {
  neutral: 'bg-surface-2 text-muted',
  live: 'bg-live-soft text-live',
  called: 'bg-called-soft text-called',
  late: 'bg-late-soft text-late',
  info: 'bg-info-soft text-info',
};

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-display text-sm leading-5 font-semibold tracking-wide whitespace-nowrap uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  'h-12 rounded-lg border-2 border-border bg-surface px-3 text-text outline-none transition focus:border-text disabled:cursor-not-allowed disabled:opacity-50';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input className={`${inputClass} ${className}`} {...props} />;
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return <select className={`${inputClass} ${className}`} {...props} />;
}

/** A checkbox that lines up with the bottom of the Fields beside it. */
export function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`flex items-center gap-2 self-end pb-2 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        className="h-5 w-5 shrink-0 accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={`rounded-lg border border-border bg-surface p-3 text-text outline-none transition focus:border-text ${className}`}
      {...props}
    />
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-late-soft px-3 py-2 text-sm text-late">
      {children}
    </p>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <p className="py-10 text-center text-muted">{label}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl bg-surface-2 px-4 py-10 text-center text-muted">{children}</p>;
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      /* Centered card on larger screens; a bottom sheet on phones. */
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-3xl bg-surface p-0 text-text backdrop:bg-black/50 max-sm:mb-0 max-sm:max-h-[92dvh] max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between bg-surface px-5 pt-5 pb-2">
        <h2 className="text-2xl">{title}</h2>
        <button onClick={onClose} className="inline-flex h-11 items-center gap-1 rounded-full bg-surface-2 px-4 font-medium hover:bg-border" aria-label="Close">
          Close
        </button>
      </div>
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{open && children}</div>
    </dialog>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-5xl sm:text-6xl">{title}</h1>
        {subtitle && <div className="mt-2 text-lg text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
