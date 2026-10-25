import { describe, expect, it } from 'vitest';
import { DUPR_COLUMNS, duprCsv, parseRatings } from '../../web/src/lib/dupr';
import type { DuprResultRow } from '../../web/src/lib/types';

const row: DuprResultRow = {
  match_id: 'm1',
  event_id: 'e1',
  event_name: 'Mixed 3.5',
  label: 'Final',
  completed_at: '2026-11-07T18:00:00Z',
  match_type: 'D',
  event: 'Fall Open - Mixed 3.5',
  date: '2026-11-07',
  player_a1: 'Pat Able',
  player_a1_dupr_id: 'AB12CD',
  player_a2: 'Sam Baker',
  player_a2_dupr_id: 'EF34GH',
  player_b1: 'Jo Cole',
  player_b1_dupr_id: 'IJ56KL',
  player_b2: 'Ana Dunn',
  player_b2_dupr_id: 'MN78OP',
  games: [
    [11, 7],
    [9, 11],
    [11, 4],
  ],
  location: 'Rocket Gym, 1 Main St, Springfield',
  score_type: 'SIDEOUT',
  missing_ids: [],
  exported_at: null,
};

describe('DUPR file', () => {
  it('writes DUPR’s 27 columns with up to five games, quoting commas', () => {
    const [header, line] = duprCsv([row]).trim().split('\r\n');
    expect(header.split(',')).toEqual([...DUPR_COLUMNS]);
    expect(DUPR_COLUMNS).toHaveLength(27);
    expect(line).toBe(
      'D,Fall Open - Mixed 3.5,2026-11-07,Pat Able,AB12CD,,Sam Baker,EF34GH,,Jo Cole,IJ56KL,,Ana Dunn,MN78OP,,' +
        '11,7,9,11,11,4,,,,,"Rocket Gym, 1 Main St, Springfield",SIDEOUT',
    );
  });

  it('reads pasted ratings in any common separator', () => {
    expect(parseRatings('7k2qxw 3.82 3.6\nAB12CD,4.05\n\nname rating\nbad!! 3')).toEqual([
      { dupr_id: '7K2QXW', doubles: 3.82, singles: 3.6 },
      { dupr_id: 'AB12CD', doubles: 4.05, singles: undefined },
    ]);
  });
});
