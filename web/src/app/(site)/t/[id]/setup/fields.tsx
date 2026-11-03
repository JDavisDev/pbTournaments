// Pieces shared by Setup's forms.
import { Button } from '@/components/ui';
import { courtsLabel } from '@/lib/format';
import type { CourtBoardRow } from '@/lib/types';

export const LEVELS = ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5', '6.0'];
export const optionalNumber = (v: string) => (v === '' ? null : Number(v));
/** A rating amount to the hundredth, as the database stores it. */
export const hundredths = (v: string) => (v === '' ? null : Math.round(Number(v) * 100) / 100);

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 font-display text-lg font-bold uppercase">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/**
 * A division's court section. Picked courts are this division's alone until
 * it's done; with none picked it plays on any court outside the sections.
 */
export function CourtPicker({
  courts,
  value,
  onChange,
}: {
  courts: CourtBoardRow[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const picked = courts.filter((c) => value.includes(c.court_id)).map((c) => c.court_name);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        {picked.length > 0
          ? `Plays only on ${courtsLabel(picked)}. Other divisions stay off these courts until this one is done.`
          : 'Any open court. Pick courts to keep this division on them.'}
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Courts">
        {courts.map((c) => {
          const on = value.includes(c.court_id);
          return (
            <button
              key={c.court_id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(c.court_id)}
              className={`h-12 min-w-12 rounded-xl border px-3 font-semibold ${
                on ? 'border-accent bg-accent text-accent-text' : 'border-border bg-surface hover:border-text'
              }`}
            >
              {c.court_name.replace(/^Court /i, '')}
            </button>
          );
        })}
        {value.length > 0 && (
          <Button type="button" variant="ghost" onClick={() => onChange([])}>
            Any court
          </Button>
        )}
      </div>
    </div>
  );
}
