'use client';

// "Save and continue" on Settings: each card with a form registers its
// unsaved changes here, so one button can save them all.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** A card's save, or null when it has nothing unsaved. */
type Pending = RefObject<(() => Promise<void>) | null>;
type Registry = Map<string, Pending>;

const SaveAllContext = createContext<Registry | null>(null);

export function SaveAllProvider({ children }: { children: ReactNode }) {
  const [registry] = useState<Registry>(() => new Map());
  return <SaveAllContext.Provider value={registry}>{children}</SaveAllContext.Provider>;
}

/** Saves every card with unsaved changes, one at a time; returns how many it saved. */
export function useSaveAll() {
  const registry = useContext(SaveAllContext);
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

/**
 * A card's form: whether `value` differs from what was last saved, and
 * `commit`, which saves it (the card's own Save button uses it too).
 */
export function useUnsaved(name: string, value: unknown, save: () => Promise<unknown>) {
  const registry = useContext(SaveAllContext);
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
  useEffect(() => {
    if (!registry) return;
    registry.set(name, pending);
    return () => {
      registry.delete(name);
    };
  }, [registry, name]);
  return { dirty, commit };
}
