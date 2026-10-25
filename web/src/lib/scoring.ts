// Checks a score before it's saved: what blocks saving (a tie, too few games)
// and what only needs a second look (11-10 without a cap, 14-11). The database
// accepts any finished score, because formats vary.

export interface ScoringRules {
  gamesTo: number;
  bestOf: number;
  /** Hard cap: a game ends at this score even when won by 1. */
  cap: number | null;
}

/** A match's rules: its round's format, else the event's (see match_details). */
export function rulesOf(m: { games_to: number | null; best_of: number | null; point_cap: number | null }): ScoringRules {
  return { gamesTo: m.games_to ?? 11, bestOf: m.best_of ?? 1, cap: m.point_cap ?? null };
}

export function describeRules(r: ScoringRules) {
  const games = r.bestOf === 1 ? 'One game' : `Best of ${r.bestOf}`;
  return `${games} to ${r.gamesTo}, win by 2${r.cap ? `, capped at ${r.cap}` : ''}`;
}

export interface ScoreCheck {
  /** Team 1's score first. */
  games: [number, number][];
  winner: 1 | 2 | null;
  wins: [number, number];
  /** Can't be saved. */
  error: string | null;
  /** Can be saved after the director confirms. */
  warnings: string[];
}

export function checkScore(rows: [string, string][], rules: ScoringRules): ScoreCheck {
  const needed = Math.floor(rules.bestOf / 2) + 1;
  const games: [number, number][] = [];
  const wins: [number, number] = [0, 0];
  const warnings: string[] = [];
  const fail = (error: string): ScoreCheck => ({ games, winner: null, wins, error, warnings });

  for (const [i, [a, b]] of rows.entries()) {
    const n = i + 1;
    if (a === '' && b === '') continue;
    if (a === '' || b === '') return fail(`Enter both scores for game ${n}.`);
    if (wins[0] === needed || wins[1] === needed) return fail(`The match was already won before game ${n}.`);
    const g: [number, number] = [Number(a), Number(b)];
    const [hi, lo] = [Math.max(...g), Math.min(...g)];
    if (hi > 99) return fail(`Game ${n}: ${hi} isn’t a possible score.`);
    if (hi === lo) return fail(`Game ${n} can’t end tied.`);
    games.push(g);
    wins[g[0] > g[1] ? 0 : 1] += 1;

    const label = rules.bestOf === 1 ? 'The game' : `Game ${n}`;
    const cappedFinish = rules.cap !== null && hi === rules.cap;
    if (rules.cap !== null && hi > rules.cap) {
      warnings.push(`${label} went past the cap of ${rules.cap} (${hi}–${lo}).`);
    } else if (hi < rules.gamesTo) {
      warnings.push(`${label} ended at ${hi}–${lo}, before reaching ${rules.gamesTo}.`);
    } else if (hi - lo === 1 && !cappedFinish) {
      warnings.push(`${label} was won by 1 point (${hi}–${lo}).`);
    } else if (hi > rules.gamesTo && hi - lo > 2 && !cappedFinish) {
      warnings.push(`${label} went past ${rules.gamesTo} but wasn’t won by 2 (${hi}–${lo}).`);
    }
  }

  if (games.length === 0) return fail('Enter the score.');
  if (wins[0] < needed && wins[1] < needed) {
    return fail(`Best of ${rules.bestOf}: a team needs ${needed} game wins.`);
  }
  return { games, winner: wins[0] === needed ? 1 : 2, wins, error: null, warnings };
}

/** "11–9" or "2–1 (11–9, 8–11, 11–6)", from the winner's side. */
export function winnerScoreline(check: ScoreCheck) {
  if (!check.winner) return '';
  const w = check.winner - 1;
  const l = 1 - w;
  const games = check.games.map((g) => `${g[w]}–${g[l]}`);
  return games.length === 1 ? games[0] : `${check.wins[w]}–${check.wins[l]} (${games.join(', ')})`;
}
