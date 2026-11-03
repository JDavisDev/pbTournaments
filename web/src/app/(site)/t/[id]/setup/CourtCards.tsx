'use client';

import { useState } from 'react';
import { Check, Field, Input, Select } from '@/components/ui';
import { renameCourt, setCourtChampionshipRank, setCourtStream, updateTournament } from '@/lib/api';
import { championshipModes, championshipRankLabel } from '@/lib/format';
import type { CourtBoardRow, RoundKey, Tournament } from '@/lib/types';
import { isYoutubeUrl } from '@/lib/youtube';
import { useUnsaved } from './SaveAll';
import { SettingsGroup } from './SetupCards';

/** YouTube links: one for the whole event, and one per streamed court. */
export function StreamsCard({ tournament, courts }: { tournament: Tournament; courts: CourtBoardRow[] }) {
  const [main, setMain] = useState(tournament.stream_url ?? '');
  const [perCourt, setPerCourt] = useState<Record<string, { name: string; url: string }>>(() =>
    Object.fromEntries(courts.map((c) => [c.court_id, { name: c.court_name, url: c.stream_url ?? '' }])),
  );
  const bad = [main, ...Object.values(perCourt).map((c) => c.url)].find((u) => u.trim() && !isYoutubeUrl(u.trim()));
  useUnsaved('streams', { main, perCourt }, async () => {
    if (bad) throw new Error(`“${bad}” isn’t a YouTube link.`);
    await updateTournament(tournament.id, { stream_url: main.trim() || null });
    for (const c of courts) {
      const next = perCourt[c.court_id];
      if (!next) continue;
      if (next.url.trim() !== (c.stream_url ?? '')) await setCourtStream(c.court_id, next.url.trim() || null);
      if (next.name.trim() && next.name.trim() !== c.court_name) await renameCourt(c.court_id, next.name.trim());
    }
  });
  const streamed = (main.trim() ? 1 : 0) + Object.values(perCourt).filter((c) => c.url.trim()).length;

  return (
    <SettingsGroup
      title="Live streams"
      foldable
      summary={streamed ? `${streamed} stream${streamed === 1 ? '' : 's'}` : 'None'}
      description="Paste YouTube links. Players see “Watch live” on the tournament page, and their court’s stream when their match is on it. Court names are set here too."
    >
      <Field label="Main stream">
        <Input placeholder="https://youtube.com/live/…" value={main} onChange={(e) => setMain(e.target.value)} />
      </Field>
      {courts.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Courts</span>
          {courts.map((c) => {
            const v = perCourt[c.court_id] ?? { name: c.court_name, url: '' };
            const update = (patch: Partial<typeof v>) => setPerCourt((p) => ({ ...p, [c.court_id]: { ...v, ...patch } }));
            return (
              <div key={c.court_id} className="grid grid-cols-[6.5rem_1fr] gap-2">
                <Input aria-label="Court name" value={v.name} onChange={(e) => update({ name: e.target.value })} />
                <Input aria-label={`${c.court_name} stream`} placeholder="No stream" value={v.url} onChange={(e) => update({ url: e.target.value })} />
              </div>
            );
          })}
        </div>
      )}
      {bad && <p className="text-sm text-late">“{bad}” isn’t a YouTube link.</p>}
    </SettingsGroup>
  );
}

// Finals and grand finals are one choice: both are a division's last match.
const championshipRoundChoices: { label: string; keys: RoundKey[] }[] = [
  { label: 'Quarterfinals', keys: ['quarterfinal'] },
  { label: 'Semifinals', keys: ['semifinal'] },
  { label: 'Bronze', keys: ['bronze'] },
  { label: 'Finals', keys: ['final', 'grand_final'] },
];

/** Featured courts (commentary, a stream) that get the big bracket rounds first. */
export function ChampionshipCard({ tournament, courts }: { tournament: Tournament; courts: CourtBoardRow[] }) {
  const [ranks, setRanks] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(courts.map((c) => [c.court_id, c.championship_rank])),
  );
  const [form, setForm] = useState({
    mode: tournament.championship_mode,
    rounds: tournament.championship_rounds,
    wait: tournament.championship_wait_minutes?.toString() ?? '',
    finalWait: tournament.final_wait_minutes?.toString() ?? '',
  });
  const minutes = (value: string) => (value.trim() === '' ? null : Math.max(1, Math.round(Number(value))));
  useUnsaved('championship', { ranks, form }, async () => {
    await updateTournament(tournament.id, {
      championship_mode: form.mode,
      championship_rounds: form.rounds,
      championship_wait_minutes: minutes(form.wait),
      final_wait_minutes: minutes(form.finalWait),
    });
    for (const c of courts) {
      const next = ranks[c.court_id] ?? null;
      if (next !== c.championship_rank) await setCourtChampionshipRank(c.court_id, next);
    }
  });
  const hasRound = (keys: RoundKey[]) => keys.every((k) => form.rounds.includes(k));
  const toggleRound = (keys: RoundKey[], on: boolean) =>
    setForm((f) => ({ ...f, rounds: on ? [...new Set([...f.rounds, ...keys])] : f.rounds.filter((r) => !keys.includes(r)) }));
  const featured = Object.values(ranks).filter((r) => r !== null).length;

  return (
    <SettingsGroup
      title="Championship courts"
      foldable
      summary={featured ? `${featured} court${featured === 1 ? '' : 's'}` : 'None'}
      description="Your featured courts, e.g. the one with commentary. They play pool matches until the big rounds, then get those first."
    >
      {courts.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Courts</span>
          {courts.map((c) => (
            <div key={c.court_id} className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
              <span className="text-sm">{c.court_name}</span>
              <Select
                aria-label={`${c.court_name} championship rank`}
                value={ranks[c.court_id] ?? ''}
                onChange={(e) => setRanks((r) => ({ ...r, [c.court_id]: e.target.value ? Number(e.target.value) : null }))}
              >
                <option value="">Not championship</option>
                {courts.map((_, i) => (
                  <option key={i} value={i + 1}>
                    {championshipRankLabel(i + 1)}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">When the championship courts are busy</legend>
        {championshipModes.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={form.mode === m.value}
            onClick={() => setForm((f) => ({ ...f, mode: m.value }))}
            className={`rounded-lg border px-3 py-2 text-left ${
              form.mode === m.value ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2'
            }`}
          >
            <div className="text-sm font-medium">{m.label}</div>
            <div className="text-xs text-muted">{m.hint}</div>
          </button>
        ))}
      </fieldset>

      {form.mode === 'wait' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Wait at most (min)" hint="Blank = no limit">
            <Input type="number" min={1} inputMode="numeric" value={form.wait} onChange={(e) => setForm((f) => ({ ...f, wait: e.target.value }))} />
          </Field>
          <Field label="Finals wait (min)" hint="For the Main court">
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              value={form.finalWait}
              onChange={(e) => setForm((f) => ({ ...f, finalWait: e.target.value }))}
            />
          </Field>
        </div>
      )}

      <div className="flex flex-col">
        <span className="text-sm font-medium">Rounds that go there</span>
        <div className="grid grid-cols-2">
          {championshipRoundChoices.map((r) => (
            <Check key={r.label} label={r.label} checked={hasRound(r.keys)} onChange={(on) => toggleRound(r.keys, on)} />
          ))}
        </div>
      </div>
    </SettingsGroup>
  );
}
