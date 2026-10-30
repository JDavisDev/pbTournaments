'use client';

// One Save for Settings: each section with a form registers its unsaved
// changes here, so the save bar (and "Continue to divisions") can save them all.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** A section's save, or null when it has nothing unsaved. */
type Pending = RefObject<(() => Promise<void>) | null>;
type Registry = Map<string, Pending>;

const SaveAllContext = createContext<{
  registry: Registry;
  /** Sections with unsaved changes, by name. */
  unsaved: Set<string>;
  mark: (name: string, unsaved: boolean) => void;
} | null>(null);

export function SaveAllProvider({ children }: { children: ReactNode }) {
  const [registry] = useState<Registry>(() => new Map());
  const [unsaved, setUnsaved] = useState<Set<string>>(() => new Set());
  const mark = useCallback(
    (name: string, on: boolean) =>
      setUnsaved((s) => {
        if (s.has(name) === on) return s;
        const next = new Set(s);
        if (on) next.add(name);
        else next.delete(name);
        return next;
      }),
    [],
  );
  return <SaveAllContext.Provider value={{ registry, unsaved, mark }}>{children}</SaveAllContext.Provider>;
}

/** Saves every section with unsaved changes, one at a time; returns how many it saved. */
export function useSaveAll() {
  const registry = useContext(SaveAllContext)?.registry;
  return async () => {
    let saved = 0;
    for (const pending of registry?.values() ?? []) {
      if (pending.current) {
        await pending.current();
        saved++;
      }
    }
    return saved;
  };
}

/** Names of the sections with unsaved changes. */
export function useUnsavedSections(): Set<string> {
  return useContext(SaveAllContext)?.unsaved ?? new Set();
}

/**
 * A section's form: whether `value` differs from what was last saved, and
 * `commit`, which saves it. `save` throws to refuse (e.g. a missing name).
 */
export function useUnsaved(name: string, value: unknown, save: () => Promise<unknown>) {
  const context = useContext(SaveAllContext);
  const [baseline, setBaseline] = useState(() => JSON.stringify(value));
  const current = JSON.stringify(value);
  const dirty = current !== baseline;
  const commit = async () => {
    await save();
    setBaseline(current);
  };
  const pending = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    pending.current = dirty ? commit : null;
  });
  const registry = context?.registry;
  const mark = context?.mark;
  useEffect(() => {
    if (!registry) return;
    registry.set(name, pending);
    return () => {
      registry.delete(name);
    };
  }, [registry, name]);
  useEffect(() => {
    mark?.(name, dirty);
  }, [mark, name, dirty]);
  useEffect(() => () => mark?.(name, false), [mark, name]);
  return { dirty, commit };
}
