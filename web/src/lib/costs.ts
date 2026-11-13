// What it costs to run Courtside, shown on the pricing page ("Where the money
// goes"). Keep this current: when a plan or bill changes, change it here and
// move COSTS_UPDATED. Amounts are what we're billed, in US cents.

/** When these figures were last checked against the bills (YYYY-MM-DD). */
export const COSTS_UPDATED = '2026-11-13';

export interface MonthlyCost {
  name: string;
  /** What it does for players and directors, in plain words. */
  does: string;
  plan: string;
  monthlyCents: number;
  /** Only paid while texting is available (see textingAvailable). */
  texting?: boolean;
}

/** Fixed bills, whatever the number of tournaments. */
export const MONTHLY_COSTS: MonthlyCost[] = [
  { name: 'Vercel', does: 'Runs the website and sends every page to your phone', plan: 'Pro', monthlyCents: 2000 },
  { name: 'Supabase', does: 'The database: tournaments, teams, brackets, scores and sign-ins, with daily backups', plan: 'Pro', monthlyCents: 2500 },
  { name: 'Resend', does: 'Registration receipts, waitlist offers and sign-in emails', plan: 'Pro, up to 50,000 emails a month', monthlyCents: 2000 },
  { name: 'Domain name', does: 'The courtside address, paid yearly', plan: 'Yearly, shown per month', monthlyCents: 125 },
  { name: 'Cloudflare Turnstile', does: 'Keeps bots off the sign-up and registration forms', plan: 'Free', monthlyCents: 0 },
  { name: 'Twilio number', does: 'The toll-free number court calls are texted from', plan: 'Toll-free number', monthlyCents: 215, texting: true },
];

export interface UsageCost {
  name: string;
  does: string;
  rate: string;
  texting?: boolean;
}

/** Bills that grow with use. */
export const USAGE_COSTS: UsageCost[] = [
  {
    name: 'Stripe',
    does: 'Card processing on the fees paid to us: setup fees, and player fees paid from the Finance page',
    rate: '2.9% + 30¢ per payment',
  },
  { name: 'Resend', does: 'Once we send more than 50,000 emails a month', rate: '$90 a month for up to 100,000' },
  { name: 'Twilio', does: 'Each text, plus the carriers’ own fees', rate: 'About 1¢ per text', texting: true },
];
