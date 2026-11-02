'use client';

// Deleting your own account: what goes, what the tournaments keep, and a
// typed confirmation.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorText, Field, Input } from '@/components/ui';
import { deleteMyAccount } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { logOut } from '@/lib/profile';

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useAction();
  const router = useRouter();
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <h2 className="text-2xl">Delete your account</h2>
      {!open ? (
        <Button variant="ghost" className="self-start text-late" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      ) : (
        <>
          <p>
            This removes your login and your details: name, email, phone, birthday, gender, ratings and DUPR ID. Your answers to
            registration questions, your messages and your alert phones go too.
          </p>
          <p className="text-muted">
            Tournaments keep their registration and payment records and their results, without your name. Team names in past
            results, like “Davis/Lee”, stay as they were. You can’t delete your account while you’re entered in a tournament that
            isn’t over, have money owed either way, or are the only person running a tournament.
          </p>
          <Field label="Type DELETE to confirm">
            <Input value={typed} autoCapitalize="characters" onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={busy || typed.trim().toUpperCase() !== 'DELETE'}
              onClick={() =>
                run(async () => {
                  await deleteMyAccount();
                  await logOut();
                  router.replace('/profile?deleted=1');
                })
              }
            >
              {busy ? 'Deleting…' : 'Delete my account'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => (setOpen(false), setTyped(''))}>
              Keep my account
            </Button>
          </div>
          <ErrorText>{error}</ErrorText>
        </>
      )}
    </section>
  );
}
