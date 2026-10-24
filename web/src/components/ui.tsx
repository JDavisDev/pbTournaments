'use client';

import Link from 'next/link';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-text hover:opacity-90',
  secondary: 'bg-surface border border-border hover:bg-surface-2',
  ghost: 'hover:bg-surface-2',
  danger: 'bg-late text-white hover:opacity-90',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const sizing = size === 'sm' ? 'h-8 px-2.5 text-sm' : 'h-10 px-4';
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${variants[variant]} ${className}`}
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
      className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-4 font-medium transition ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({ className = '', ...props }: ComponentProps<'div'>) {
  return <div className={`rounded-xl border border-border bg-surface ${className}`} {...props} />;
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
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]}`}>
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
  'h-10 rounded-lg border border-border bg-surface px-3 text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/30';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input className={`${inputClass} ${className}`} {...props} />;
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return <select className={`${inputClass} ${className}`} {...props} />;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={`rounded-lg border border-border bg-surface p-3 text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 ${className}`}
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
  return <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-muted">{children}</p>;
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
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-0 text-text backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="font-semibold">{title}</h2>
        <button onClick={onClose} className="rounded-lg px-2 py-1 text-muted hover:bg-surface-2" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="p-5">{open && children}</div>
    </dialog>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
