'use client';

// The tournament's announcement: a yellow notice at the top of its pages for
// last-minute changes. Directors edit it right there.
import { Fragment, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Button, ErrorText, Textarea } from '@/components/ui';
import { updateTournament } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { Tournament } from '@/lib/types';

export const ANNOUNCEMENT_MAX = 500;

/** Text with its web addresses as links. */
export function Linked({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all underline">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/**
 * The notice, when there is one. `editable` (directors): an Edit button, and
 * with no announcement a "Post an announcement" button instead of nothing.
 */
export function Announcement({
  tournament: t,
  editable = false,
  onChanged,
}: {
  tournament: Tournament;
  editable?: boolean;
  onChanged?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const save = (value: string | null) =>
    run(() => updateTournament(t.id, { announcement: value }), () => (setEditing(false), onChanged?.()));

  if (editing) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border-2 border-warn bg-warn-soft p-4">
        <label htmlFor="announcement" className="font-semibold">
          Announcement
        </label>
        <Textarea
          id="announcement"
          rows={3}
          autoFocus
          maxLength={ANNOUNCEMENT_MAX}
          value={text}
          placeholder="Courts 5–8 are moving to the north gym at noon."
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-xs text-muted">
          {text.length}/{ANNOUNCEMENT_MAX}. Shows at the top of the tournament’s pages for everyone.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !text.trim()} onClick={() => save(text.trim())}>
            Post
          </Button>
          {t.announcement && (
            <Button variant="ghost" className="text-late" disabled={busy} onClick={() => save(null)}>
              Take it down
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    );
  }

  if (!t.announcement) {
    if (!editable) return null;
    return (
      <button
        onClick={() => (setText(''), setEditing(true))}
        className="inline-flex items-center gap-2 self-start rounded-full border-2 border-dashed border-warn px-4 py-2 text-sm font-semibold hover:bg-warn-soft"
      >
        <Icon name="megaphone" /> Post an announcement
      </button>
    );
  }

  return (
    <div role="status" className="flex items-start gap-3 rounded-2xl border-2 border-warn bg-warn-soft p-4">
      <Icon name="megaphone" className="mt-0.5 h-6 w-6 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold whitespace-pre-wrap">
          <Linked text={t.announcement} />
        </p>
        {t.announcement_at && <p className="mt-1 text-sm text-muted">Posted {formatTime(t.announcement_at, t.time_zone)}</p>}
      </div>
      {editable && (
        <Button size="sm" variant="ghost" onClick={() => (setText(t.announcement ?? ''), setEditing(true))}>
          Edit
        </Button>
      )}
    </div>
  );
}
