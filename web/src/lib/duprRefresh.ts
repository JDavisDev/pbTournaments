// Refreshing a tournament's ratings: from DUPR when the site has partner keys,
// with made-up ratings on a demo site so the warnings can be tried.
import { getDuprRefreshList, importDuprRatings } from './api';
import { isDemoMode, isLocalMode } from './config';
import { postJson } from './http';
import type { RatingsImport } from './types';

export interface RatingRefresh {
  /** No DUPR connection: nothing was refreshed. */
  connected: boolean;
  /** Test ratings, not DUPR's. */
  simulated: boolean;
  result: RatingsImport | null;
  noDuprId: string[];
  notFound: string[];
  noRating: string[];
}

const empty = { result: null, noDuprId: [], notFound: [], noRating: [] };

/** Nudges each rating up or down by as much as 0.35; anyone without one gets a mid-level rating. */
async function simulate(tournamentId: string): Promise<RatingRefresh> {
  const nudge = (from: number | null) => {
    const base = from === null ? 3.5 : Number(from);
    return Math.round(Math.min(7, Math.max(2, base + (Math.random() - 0.5) * 0.7)) * 1000) / 1000;
  };
  const players = await getDuprRefreshList(tournamentId);
  const result = await importDuprRatings(
    tournamentId,
    players.map((p) => ({ player_id: p.player_id, doubles: nudge(p.dupr_doubles), singles: nudge(p.dupr_singles) })),
  );
  return { ...empty, connected: true, simulated: true, result };
}

export async function refreshDuprRatings(tournamentId: string): Promise<RatingRefresh> {
  if (isLocalMode) return simulate(tournamentId);
  const body = await postJson<Omit<RatingRefresh, 'simulated'>>('/api/dupr/refresh', { tournamentId }, { signedIn: true });
  if (!body.connected) return isDemoMode ? simulate(tournamentId) : { ...empty, connected: false, simulated: false };
  return { simulated: false, ...body };
}
