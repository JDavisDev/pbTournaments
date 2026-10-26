'use client';

// A card that folds away: a title, a one-line summary and an arrow; tap to
// open the full card. Player pages keep their own information up front and
// put the extras (standings, brackets, other divisions) in these, so the
// default view stays simple. Open or closed is remembered on this device.
import { useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from './Icon';

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const read = (key: string): boolean | null => {
  try {
    const v = localStorage.getItem(`courtside-open:${key}`);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
};
const write = (key: string, open: boolean) => {
  try {
    localStorage.setItem(`courtside-open:${key}`, open ? '1' : '0');
  } catch {}
  listeners.forEach((l) => l());
};

export function Expandable({
  id,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  /** Remembers open/closed under this name, e.g. "standings". */
  id: string;
  title: string;
  /** Shown beside the title, open or closed: "2nd of 5", "8 on court". */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const open = useSyncExternalStore(subscribe, () => read(id) ?? defaultOpen, () => defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now !== open) write(id, now);
      }}
      className="group rounded-2xl border border-border bg-surface"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block font-display text-2xl leading-tight font-bold uppercase">{title}</span>
          {summary && <span className="block text-muted">{summary}</span>}
        </span>
        <Icon name="chevron" className="h-6 w-6 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pt-1 pb-4">{children}</div>
    </details>
  );
}
