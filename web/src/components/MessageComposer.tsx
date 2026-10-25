'use client';

import { useState } from 'react';
import { sendMessage } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { MessageScope } from '@/lib/types';
import { Button, ErrorText, Field, Input, Select, Textarea } from './ui';

export interface Recipient {
  scope: MessageScope;
  target: string | null;
  label: string;
}

/**
 * Write a text and/or email. With one fixed recipient (a team or player) it
 * just sends to them; otherwise it offers a list to choose from.
 */
export function MessageComposer({
  tournamentId,
  recipients,
  onSent,
}: {
  tournamentId: string;
  recipients: Recipient[];
  onSent?: (count: number) => void;
}) {
  const [to, setTo] = useState(0);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [via, setVia] = useState({ sms: true, email: false });
  const [sent, setSent] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const recipient = recipients[to];
  const segments = Math.max(1, Math.ceil(body.length / 160));

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const channels = (['sms', 'email'] as const).filter((c) => via[c]);
        run(async () => {
          const count = await sendMessage(tournamentId, recipient.scope, recipient.target, body, [...channels], subject || undefined);
          setSent(`Queued ${count} message${count === 1 ? '' : 's'} to ${recipient.label}.`);
          setBody('');
          onSent?.(count);
        });
      }}
    >
      {recipients.length > 1 && (
        <Field label="To">
          <Select value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {recipients.map((r, i) => (
              <option key={`${r.scope}-${r.target}`} value={i}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex gap-4 text-sm">
        {(['sms', 'email'] as const).map((c) => (
          <label key={c} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--accent)]"
              checked={via[c]}
              onChange={(e) => setVia({ ...via, [c]: e.target.checked })}
            />
            {c === 'sms' ? 'Text' : 'Email'}
          </label>
        ))}
      </div>
      {via.email && (
        <Field label="Email subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Tournament update" />
        </Field>
      )}
      <Field
        label="Message"
        hint={via.sms ? `${body.length} characters${body.length > 160 ? ` · ${segments} text segments each` : ''}` : undefined}
      >
        <Textarea rows={4} required value={body} onChange={(e) => setBody(e.target.value)} placeholder="Courts 1–4 are moving to the north gym…" />
      </Field>
      <ErrorText>{error}</ErrorText>
      {sent && <p className="text-sm text-live">{sent}</p>}
      <Button variant="primary" type="submit" disabled={busy || !body.trim() || (!via.sms && !via.email)}>
        Send to {recipient.label}
      </Button>
    </form>
  );
}
