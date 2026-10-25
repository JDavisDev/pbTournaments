// DUPR's club "Import Matches via CSV" file. Columns as in DUPR's template
// (Club → Matches → Add Matches → Import Matches via CSV); team A is team 1.
import type { DuprResultRow } from './types';

export const DUPR_COLUMNS = [
  'matchType', 'event', 'date',
  'playerA1', 'playerA1DuprId', 'playerA1ExternalId',
  'playerA2', 'playerA2DuprId', 'playerA2ExternalId',
  'playerB1', 'playerB1DuprId', 'playerB1ExternalId',
  'playerB2', 'playerB2DuprId', 'playerB2ExternalId',
  'teamAGame1', 'teamBGame1', 'teamAGame2', 'teamBGame2', 'teamAGame3', 'teamBGame3',
  'teamAGame4', 'teamBGame4', 'teamAGame5', 'teamBGame5',
  'location', 'scoreType',
] as const;

const cell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function duprRow(r: DuprResultRow): (string | number | null)[] {
  const games = Array.from({ length: 5 }, (_, i) => r.games[i] ?? [null, null]).flat();
  return [
    r.match_type, r.event, r.date,
    r.player_a1, r.player_a1_dupr_id, null,
    r.player_a2, r.player_a2_dupr_id, null,
    r.player_b1, r.player_b1_dupr_id, null,
    r.player_b2, r.player_b2_dupr_id, null,
    ...games,
    r.location, r.score_type,
  ];
}

/** The CSV text for these matches. */
export function duprCsv(rows: DuprResultRow[]) {
  return [DUPR_COLUMNS.join(','), ...rows.map((r) => duprRow(r).map(cell).join(','))].join('\r\n') + '\r\n';
}

/** Lets the browser save the file. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * "7K2QXW 3.82 3.6" or "7K2QXW, 3.82" per line (doubles, then singles) into
 * rows for import_dupr_ratings. Lines without an ID and a rating (headers) are skipped.
 */
export function parseRatings(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[\s,;\t]+/).filter(Boolean))
    .filter((parts) => parts.length >= 2 && /^[A-Za-z0-9]{4,12}$/.test(parts[0]))
    .map(([id, doubles, singles]) => ({
      dupr_id: id.toUpperCase(),
      doubles: Number.isFinite(Number(doubles)) ? Number(doubles) : undefined,
      singles: singles !== undefined && Number.isFinite(Number(singles)) ? Number(singles) : undefined,
    }))
    .filter((r) => r.doubles !== undefined || r.singles !== undefined);
}
