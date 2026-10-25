'use client';

import { useSyncExternalStore } from 'react';
import { Icon } from './Icon';

const sizes = [
  { key: '', label: 'Normal' },
  { key: 'large', label: 'Large' },
  { key: 'larger', label: 'Larger' },
] as const;
const KEY = 'courtside-text-size';

// The size lives on <html data-text> (set before paint by the root layout).
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const read = () => document.documentElement.dataset.text ?? '';

/** Cycles the page's text size; remembered on this device. */
export function TextSizeButton() {
  const size = useSyncExternalStore(subscribe, read, () => '');
  const current = sizes.findIndex((s) => s.key === size);
  const next = sizes[(current + 1) % sizes.length];
  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.dataset.text = next.key;
        if (!next.key) delete document.documentElement.dataset.text;
        try {
          if (next.key) localStorage.setItem(KEY, next.key);
          else localStorage.removeItem(KEY);
        } catch {}
        listeners.forEach((l) => l());
      }}
      className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border border-border px-3 font-medium whitespace-nowrap hover:border-text"
      aria-label={`Text size: ${sizes[Math.max(current, 0)].label}. Change to ${next.label}.`}
    >
      <Icon name="text" />
      <span className="max-sm:sr-only">{current > 0 ? `${sizes[current].label} text` : 'Text size'}</span>
    </button>
  );
}
