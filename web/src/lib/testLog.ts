'use client';

// Test menu: a running list of what the app asked the backend to do and what
// came back, to see why something went wrong. Demo and local sites only.
import { useSyncExternalStore } from 'react';

export interface LogEntry {
  at: string;
  call: string;
  args: unknown;
  ok: boolean;
  result: unknown;
  ms: number;
}

const KEY = 'courtside-test-log';
const LIMIT = 50;
const none: LogEntry[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

let entries: LogEntry[] | null = null;
function read(): LogEntry[] {
  if (entries) return entries;
  try {
    // Kept for the tab: checkout leaves the page and comes back.
    entries = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as LogEntry[];
  } catch {
    entries = [];
  }
  return entries;
}

function write(next: LogEntry[]) {
  entries = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((l) => l());
}

export const useTestLog = () => useSyncExternalStore(subscribe, read, () => none);
export const clearTestLog = () => write([]);

/** Logs every call that changes something. Reads are too frequent to be useful here. */
export function logged<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, name) {
      const fn = (target as Record<string | symbol, unknown>)[name];
      if (typeof fn !== 'function' || typeof name !== 'string' || /^(get|is|check|claim)/.test(name)) return fn;
      return async (...args: unknown[]) => {
        const started = Date.now();
        const add = (ok: boolean, result: unknown) =>
          write([{ at: new Date().toLocaleTimeString(), call: name, args, ok, result, ms: Date.now() - started }, ...read()].slice(0, LIMIT));
        try {
          const result = await fn(...args);
          add(true, result ?? null);
          return result;
        } catch (e) {
          add(false, (e as Error).message);
          throw e;
        }
      };
    },
  });
}
