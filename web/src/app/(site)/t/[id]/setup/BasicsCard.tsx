'use client';

import { useState } from 'react';
import { ErrorText, Field, Input, Select } from '@/components/ui';
import { setBasicCheckin, setCourtCount, updateTournament } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { US_STATES } from '@/lib/places';
import type { Tournament } from '@/lib/types';
import { optionalNumber } from './fields';
import { useUnsaved } from './SaveAll';
import { SettingsGroup } from './SetupCards';

/** The tournament's settings. `startHere`: a draft's first card, with its number of courts. */
export function BasicsCard({
  tournament,
  courtCount,
  startHere = false,
}: {
  tournament: Tournament;
  courtCount?: number;
  startHere?: boolean;
}) {
  // new_tournament's placeholder name: ask for the real one.
  const unnamed = tournament.name === 'New tournament';
  const [courts, setCourts] = useState(courtCount ?? 0);
  const [form, setForm] = useState({
    name: unnamed ? '' : tournament.name,
    starts_on: tournament.starts_on,
    time_zone: tournament.time_zone,
    no_show_minutes: tournament.no_show_minutes,
    overdue_after_minutes: tournament.overdue_after_minutes,
    match_slot_minutes: tournament.match_slot_minutes,
    // Blank: teams that miss check-in never forfeit automatically.
    checkin_grace_minutes: tournament.checkin_grace_minutes?.toString() ?? '',
    location: tournament.location ?? '',
    state: tournament.state ?? '',
    ball: tournament.ball ?? '',
    contact_email: tournament.contact_email ?? '',
    dupr_score_type: tournament.dupr_score_type,
  });
  useUnsaved('details', { form, courts }, async () => {
    if (!form.name.trim()) throw new Error('Give the tournament a name.');
    if (!form.starts_on) throw new Error('Pick the tournament’s date.');
    if (form.contact_email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.contact_email.trim())) {
      throw new Error('Enter a contact email like you@example.com, or leave it blank.');
    }
    await updateTournament(tournament.id, {
      ...form,
      name: form.name.trim(),
      location: form.location.trim() || null,
      state: form.state || null,
      ball: form.ball.trim() || null,
      contact_email: form.contact_email.trim() || null,
      checkin_grace_minutes: optionalNumber(form.checkin_grace_minutes),
    });
    if (startHere && courts !== courtCount) await setCourtCount(tournament.id, courts);
  });
  const num = (key: keyof typeof form) => ({
    type: 'number',
    min: 0,
    value: form[key] as number,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: Number(e.target.value) }),
  });

  return (
    <SettingsGroup
      title={startHere ? 'Start here' : 'Basics'}
      description={
        startHere
          ? tournament.simple
            ? 'Name your tournament and set its date and courts. Then add divisions and paste in the teams.'
            : tournament.is_demo
            ? 'A practice tournament dated today, so you can run it right away. Rename it if you like, then fill the division with mock players and build its schedule.'
            : 'Name your tournament and set its date and venue. Everything else is filled in; change it below.'
          : 'Name, date, venue and how the day runs.'
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input required value={form.name} placeholder="Fall Classic" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Date" hint={startHere && !tournament.is_demo ? 'Filled in four weeks out. Check it.' : undefined}>
          <Input type="date" required value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
        </Field>
        {startHere && (
          <Field label="Courts" hint="You can change this any time, even during play.">
            <Input type="number" min={0} max={200} value={courts} onChange={(e) => setCourts(Number(e.target.value))} />
          </Field>
        )}
        <Field label="Venue" hint={tournament.simple ? undefined : 'Sent to DUPR with results'}>
          <Input placeholder="Club name, street, city" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </Field>
        <Field label="State" hint="So players can find it by state. Blank: it only shows under All states.">
          <Select value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}>
            <option value="">Choose…</option>
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ball" hint="Shown to players">
          <Input maxLength={120} placeholder="Franklin X-40" value={form.ball} onChange={(e) => setForm({ ...form, ball: e.target.value })} />
        </Field>
        <Field label="Contact email" hint="Players reach you from the tournament’s pages. Blank: no Contact button.">
          <Input type="email" placeholder="you@example.com" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
        </Field>
        {!tournament.simple && (
          <Field label="Scoring" hint="For DUPR results">
            <Select
              value={form.dupr_score_type}
              onChange={(e) => setForm({ ...form, dupr_score_type: e.target.value as Tournament['dupr_score_type'] })}
            >
              <option value="SIDEOUT">Side-out (traditional)</option>
              <option value="RALLY">Rally scoring</option>
            </Select>
          </Field>
        )}
        <Field label="Time zone">
          <Select value={form.time_zone} onChange={(e) => setForm({ ...form, time_zone: e.target.value })}>
            {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'Pacific/Honolulu'].map(
              (z) => (
                <option key={z}>{z}</option>
              ),
            )}
          </Select>
        </Field>
        {/* Basic tournaments have no check-in deadline, and nobody confirms they're on court. */}
        <div className={`grid grid-cols-2 gap-4 sm:col-span-2 ${tournament.simple ? '' : 'sm:grid-cols-4'}`}>
          {!tournament.simple && (
            <Field label="No-show (min)" hint="Flag a court after">
              <Input {...num('no_show_minutes')} />
            </Field>
          )}
          <Field label="Overdue (min)" hint="Hold players for a match after">
            <Input {...num('overdue_after_minutes')} />
          </Field>
          <Field label="Match length (min)" hint="Orders the queue">
            <Input {...num('match_slot_minutes')} />
          </Field>
          {!tournament.simple && (
            <Field label="Check-in (min)" hint="To arrive once a division starts, or forfeit. Blank: no forfeits">
              <Input
                type="number"
                min={0}
                max={240}
                placeholder="Never"
                value={form.checkin_grace_minutes}
                onChange={(e) => setForm({ ...form, checkin_grace_minutes: e.target.value })}
              />
            </Field>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}

/** Basic tournaments: check-in is optional. Saved at once, since turning it on clears everyone's check-in. */
export function CheckinCard({ tournament, onChanged }: { tournament: Tournament; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const toggle = (on: boolean) => {
    if (on && !confirm('Turn check-in on? Every team starts as not here until the desk checks its players in.')) return;
    run(() => setBasicCheckin(tournament.id, on), onChanged);
  };
  return (
    <SettingsGroup
      title="Check-in"
      foldable
      summary={tournament.basic_checkin ? 'On: the desk marks players present' : 'Off: everyone entered is here'}
    >
      <label className="flex items-start gap-3 rounded-xl bg-surface-2 p-3">
        <input
          type="checkbox"
          className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--accent)]"
          checked={tournament.basic_checkin}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          <span className="block font-semibold">Check players in at the desk</span>
          <span className="text-sm text-muted">
            Mark players present as they arrive, and only teams that are here go on court. Turn it on before play starts. Off:
            everyone entered counts as here.
          </span>
        </span>
      </label>
      <ErrorText>{error}</ErrorText>
    </SettingsGroup>
  );
}

/** Simple tournaments: who may enter scores. */
export function ScoresCard({ tournament }: { tournament: Tournament }) {
  const [anyone, setAnyone] = useState(tournament.anyone_scores);
  useUnsaved('scores', anyone, () => updateTournament(tournament.id, { anyone_scores: anyone }));
  return (
    <SettingsGroup
      title="Scores"
      description="No registration, payments or texts here: players find their names and courts on the tournament page and the TV board."
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Who enters scores</legend>
        {(
          [
            [false, 'Directors only', 'You and your court monitors enter scores at the court desk.'],
            [true, 'Anyone with the link', 'Players enter the score of a match on court from the tournament page. You can fix any score.'],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            key={label}
            type="button"
            aria-pressed={anyone === value}
            onClick={() => setAnyone(value)}
            className={`rounded-xl border px-4 py-3 text-left ${anyone === value ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2'}`}
          >
            <span className="block font-semibold">{label}</span>
            <span className="block text-sm text-muted">{hint}</span>
          </button>
        ))}
      </fieldset>
    </SettingsGroup>
  );
}
