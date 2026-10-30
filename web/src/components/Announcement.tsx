'use client';

// The tournament's announcement: a yellow notice at the top of its pages for
// last-minute changes. Directors edit it right there, or post one with Announce.
import { Fragment, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Button, ErrorText, Modal, Textarea } from '@/components/ui';
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


/** Writing or changing the announcement: post it, take it down, or cancel. */
function AnnouncementEditor({ tournament: t, onDone }: { tournament: Tournament; onDone: (changed: boolean) => void }) {
  const [text, setText] = useState(t.announcement ?? '');
  const { busy, error, run } = useAction();
  const save = (value: string | null) => run(() => updateTournament(t.id, { announcement: value }), () => onDone(true));
  return (
    <div className="flex flex-col gap-2">
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
        <Button variant="ghost" disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** The notice, when there is one. `editable` (directors) adds Edit. */
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
  if (!t.announcement) return null;
  if (editing) {
    return (
      <div className="rounded-2xl border-2 border-warn bg-warn-soft p-4">
        <AnnouncementEditor tournament={t} onDone={(changed) => (setEditing(false), changed && onChanged?.())} />
      </div>
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
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
      )}
    </div>
  );
}

/** Directors, with no announcement up: a small button that writes one in a dialog. */
export function AnnounceButton({ tournament: t, onChanged }: { tournament: Tournament; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Icon name="megaphone" /> Announce
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Post an announcement">
        <AnnouncementEditor tournament={t} onDone={(changed) => (setOpen(false), changed && onChanged?.())} />
      </Modal>
    </>
  );
}
