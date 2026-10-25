export interface PlayerName {
  first_name: string;
  last_name: string;
}

/**
 * Teams pasted one per line, best seed first: "Pat Davis / Sam Lee",
 * "Davis & Lee", "Pat Davis and Sam Lee". Single names become last names.
 */
export function parseTeams(text: string): PlayerName[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .split(/\s*[\/&,]\s*|\s+and\s+/i)
        .filter(Boolean)
        .map((full) => {
          const parts = full.split(/\s+/);
          const last = parts.pop()!;
          return { first_name: parts.join(' ') || '-', last_name: last };
        }),
    );
}

export const teamName = (players: PlayerName[]) => players.map((p) => p.last_name).join('/');
