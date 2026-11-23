'use client';

// Cancelling (any manager: archived, hidden, refunds left to send) or deleting
// (the owner, only with nothing on record) the tournament.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ANNOUNCEMENT_MAX } from '@/components/Announcement';
import { Button, ErrorText, Modal, Textarea } from '@/components/ui';
import { cancelTournament, deleteTournament, getTournamentRemoval } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import type { Tournament } from '@/lib/types';
import { SettingsGroup } from './SetupCards';

export function RemoveCard({ tournament: t, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const removal = useLoad(() => getTournamentRemoval(t.id), [t.id, t.status]);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();
  const remove = useAction();
  const r = removal.data;
  const canCancel = t.status !== 'cancelled' && t.status !== 'complete';
  if (!r || (!canCancel && !r.can_delete)) return null;

  return (
    <SettingsGroup
      title="Cancel or delete"
      foldable
      summary={t.status === 'cancelled' ? 'Cancelled' : null}
      description="Cancelling keeps the tournament for your records. Deleting removes it for good."
    >
      {canCancel && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm">
            <b>Cancel</b>: players see your announcement{t.simple ? '' : ' and get it by email'}, the tournament is hidden from the public,
            and {t.simple ? 'play stops.' : 'registration and play stop. Nothing is refunded by itself: you send refunds from the Overview.'}
          </p>
          <Button size="sm" className="text-late" onClick={() => setCancelling(true)}>
            Cancel tournament…
          </Button>
        </div>
      )}
      {r.can_delete && (
        <div className="flex flex-col items-start gap-2 border-t border-border pt-4">
          {r.deletable ? (
            <>
              <p className="text-sm">
                <b>Delete</b>: the tournament, its divisions and teams are gone for good. Only for one nobody has registered for.
              </p>
              <Button
                size="sm"
                variant="danger"
                disabled={remove.busy}
                onClick={() =>
                  confirm(`Delete ${t.name} for good? This can’t be undone.`) &&
                  remove.run(() => deleteTournament(t.id), () => router.push('/profile'))
                }
              >
                {remove.busy ? 'Deleting…' : 'Delete tournament'}
              </Button>
              <ErrorText>{remove.error}</ErrorText>
            </>
          ) : (
            <p className="text-sm text-muted">
              It has registrations or payments on record, so it can’t be deleted.
              {t.status === 'cancelled' ? ' It stays archived for your records.' : ' Cancel it instead: it’s kept, hidden, for your records.'}
            </p>
          )}
        </div>
      )}
      <CancelDialog
        tournament={t}
        open={cancelling}
        onClose={() => setCancelling(false)}
        onDone={() => (setCancelling(false), onChanged(), router.push(`/t/${t.id}`))}
      />
    </SettingsGroup>
  );
}

function CancelDialog({ tournament: t, open, onClose, onDone }: { tournament: Tournament; open: boolean; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(`${t.name} is cancelled.${t.simple ? '' : ' Everyone who paid will get a refund.'}`);
  const { busy, error, run } = useAction();
  return (
    <Modal open={open} onClose={onClose} title="Cancel the tournament?">
      <div className="flex flex-col gap-3">
        <label htmlFor="cancel-announcement" className="font-semibold">
          Announcement
        </label>
        <Textarea id="cancel-announcement" rows={4} maxLength={ANNOUNCEMENT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="text-xs text-muted">
          {text.length}/{ANNOUNCEMENT_MAX}. {t.simple ? 'Shown' : 'Emailed to everyone registered, on a team or on the waitlist, and shown'} on the
          tournament’s link.
        </p>
        <ul className="list-disc pl-5 text-sm text-muted">
          <li>Hidden from the public, and registration and play stop.</li>
          {!t.simple && <li>Unpaid and waitlisted registrations are cancelled. What players paid shows as owed to them.</li>}
          {!t.simple && <li>No refunds go out by themselves: send them from the Overview.</li>}
          <li>It’s kept for your records, and you can still edit it. It can’t be reopened.</li>
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" disabled={busy || !text.trim()} onClick={() => run(() => cancelTournament(t.id, text.trim()), onDone)}>
            {busy ? 'Cancelling…' : 'Cancel tournament'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Keep it
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
