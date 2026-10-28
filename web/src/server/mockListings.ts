// Local mode only: sample tournament listings, so the home page and
// /tournaments have something to show. Posted by a sample account that can't
// sign in. Dates count from today, and the set is posted again once it has
// all passed, so the samples never go stale.
import type { PGlite } from '@electric-sql/pglite';

const POSTER = 'sample-listings@courtside.local';

interface Sample {
  name: string;
  /** Days from today. */
  start: number;
  days?: number;
  venue?: string;
  city: string;
  state: string;
  url: string;
  /** Flyer colors (background, accent); none = no image. */
  colors?: [string, string];
}

const samples: Sample[] = [
  { name: 'Lone Star Fall Classic', start: 9, days: 2, venue: 'Austin Pickleball Center', city: 'Austin', state: 'TX', url: 'https://pickleballtournaments.com/tournaments/lone-star-fall-classic', colors: ['#0b3d2e', '#d7f04a'] },
  { name: 'Gulf Coast Senior Games', start: 16, days: 2, venue: 'Bay Area Racquet Club', city: 'Houston', state: 'TX', url: 'https://gulfcoastpickleball.org/register', colors: ['#12355b', '#ffb547'] },
  { name: 'Hill Country Holiday Open', start: 37, city: 'San Marcos', state: 'TX', url: 'https://pickleballtournaments.com/tournaments/hill-country-holiday' },
  { name: 'Big D Dink Off', start: 23, days: 3, venue: 'Dallas Indoor Pickleball', city: 'Dallas', state: 'TX', url: 'https://pickleballtournaments.com/tournaments/big-d-dink-off', colors: ['#5a1a1a', '#f4d35e'] },
  { name: 'Desert Dink Fest', start: 30, days: 3, venue: 'Mesa Tennis & Pickleball Center', city: 'Mesa', state: 'AZ', url: 'https://pickleballtournaments.com/tournaments/desert-dink-fest', colors: ['#c2562b', '#ffe8c2'] },
  { name: 'Sunshine State Shootout', start: 12, days: 2, venue: 'Naples Pickleball Center', city: 'Naples', state: 'FL', url: 'https://pickleballtournaments.com/tournaments/sunshine-state-shootout', colors: ['#006d77', '#ffddd2'] },
  { name: 'Space Coast Doubles', start: 44, city: 'Melbourne', state: 'FL', url: 'https://spacecoastpickleball.com/doubles' },
  { name: 'Golden Gate Open', start: 21, days: 2, venue: 'Golden Gate Park Courts', city: 'San Francisco', state: 'CA', url: 'https://pickleballtournaments.com/tournaments/golden-gate-open', colors: ['#1d3557', '#e63946'] },
  { name: 'Mile High Mixed', start: 26, venue: 'Apex Center', city: 'Arvada', state: 'CO', url: 'https://pickleballtournaments.com/tournaments/mile-high-mixed' },
  { name: 'Carolina Fall Smash', start: 7, days: 2, venue: 'Hamlin Park', city: 'Charleston', state: 'SC', url: 'https://pickleballtournaments.com/tournaments/carolina-fall-smash', colors: ['#2b2d42', '#8ecae6'] },
  { name: 'Peach State Classic', start: 19, days: 2, city: 'Peachtree Corners', state: 'GA', url: 'https://peachstatepickleball.org/classic', colors: ['#f28482', '#fff1e6'] },
  { name: 'Buckeye Indoor Championships', start: 51, days: 3, venue: 'Columbus Sports Complex', city: 'Columbus', state: 'OH', url: 'https://pickleballtournaments.com/tournaments/buckeye-indoor' },
];

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A simple flyer: the name over two lines on a solid color. */
function flyer(name: string, [bg, accent]: [string, string]) {
  const words = name.toUpperCase().split(' ');
  const half = Math.ceil(words.length / 2);
  const lines = [words.slice(0, half).join(' '), words.slice(half).join(' ')];
  // Long lines get smaller so they stay clear of the circle.
  const size = Math.min(58, Math.floor(700 / Math.max(...lines.map((l) => l.length))));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450">
<rect width="800" height="450" fill="${bg}"/><circle cx="660" cy="110" r="80" fill="${accent}"/>
<rect x="60" y="300" width="120" height="10" fill="${accent}"/>
<text x="60" y="190" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="${size}" fill="#fff">${escape(lines[0])}</text>
<text x="60" y="260" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="${size}" fill="${accent}">${escape(lines[1])}</text>
<text x="60" y="370" font-family="Arial,sans-serif" font-size="30" fill="#fff">PICKLEBALL TOURNAMENT</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export async function seedMockListings(db: PGlite) {
  await db.query(`insert into auth.users (email) values ($1) on conflict (email) do nothing`, [POSTER]);
  const poster = (await db.query<{ id: string }>('select id from auth.users where email = $1', [POSTER])).rows[0].id;
  const upcoming = await db.query('select 1 from public.tournament_listings where created_by = $1 and last_day >= current_date', [
    poster,
  ]);
  if (upcoming.rows.length) return;
  await db.query('delete from public.tournament_listings where created_by = $1', [poster]);
  for (const [i, s] of samples.entries()) {
    await db.query(
      `insert into public.tournament_listings
         (name, starts_on, ends_on, venue, city, state, signup_url, image_data, created_by, created_at)
       values ($1, current_date + $2::int, case when $3::int > 1 then current_date + $2::int + $3::int - 1 end,
               $4, $5, $6, $7, $8, $9, now() - make_interval(hours => $10))`,
      [s.name, s.start, s.days ?? 1, s.venue ?? null, s.city, s.state, s.url, s.colors ? flyer(s.name, s.colors) : null, poster, i * 7],
    );
  }
}
