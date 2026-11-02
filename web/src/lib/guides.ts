// The guides at /docs: an outline to write into. Each section has either its
// text, or a `todo` saying what it should cover; `screenshot` names the
// screen to capture for it (files go in web/public/docs/<slug>/).

export interface GuideSection {
  heading: string;
  body?: string;
  todo?: string;
  /** What the screenshot shows, until there's an image. */
  screenshot?: string;
  /** The image once captured, e.g. '/docs/payments/connect.png'. */
  image?: string;
}

export interface Guide {
  slug: string;
  audience: 'players' | 'directors';
  title: string;
  summary: string;
  sections: GuideSection[];
}

export const guides: Guide[] = [
  {
    slug: 'registering',
    audience: 'players',
    title: 'Registering for a tournament',
    summary: 'Find a tournament, choose your events, pair with a partner and pay.',
    sections: [
      { heading: 'Find a tournament', todo: 'Tournaments page, searching by state, the listing card and its all-in price.', screenshot: 'Tournaments page' },
      { heading: 'Choose your events', todo: 'Division rules (ratings, ages, mixed), why an event might be unavailable.', screenshot: 'Registration form, events step' },
      { heading: 'Your partner', todo: 'Naming a partner by email, paying their entry, the sign-up link to send them, being paired by the desk.' },
      { heading: 'Paying, the waitlist and withdrawing', todo: 'Checkout, waitlist offers, the confirmation email link, withdrawing and refunds.', screenshot: 'Registration done page' },
    ],
  },
  {
    slug: 'tournament-day',
    audience: 'players',
    title: 'Tournament day',
    summary: 'Check in, find your court and report your scores.',
    sections: [
      { heading: 'Check in', todo: 'The desk QR code, “Jamie Checking In” and Confirm, finding your name, partners checking in separately, the deadline.', screenshot: 'Self check-in on a phone' },
      { heading: 'Your court', todo: 'Court call texts and alerts, the team page, court changes.', screenshot: 'Team page with a match on court' },
      { heading: 'Report your score', todo: 'The score link, entering games, what happens when scores disagree, asking the desk to fix one.', screenshot: 'Score entry' },
      { heading: 'Brackets and results', todo: 'Pool standings, tiebreaks, the bracket, watching on the TV board.' },
    ],
  },
  {
    slug: 'app-and-alerts',
    audience: 'players',
    title: 'The Home Screen app and match alerts',
    summary: 'Add Courtside to your phone and get a notification when your match is called.',
    sections: [
      { heading: 'Add to your Home Screen', todo: 'iPhone and Android steps (the same as Help).', screenshot: 'Add to Home Screen sheet' },
      { heading: 'Turn on match alerts', todo: 'Logging in inside the app, Turn on, the test alert, alerts replacing texts.', screenshot: 'Match alerts card' },
      { heading: 'If alerts don’t arrive', todo: 'The messages on the card and how to fix each (Help → Match alerts).' },
    ],
  },
  {
    slug: 'account',
    audience: 'players',
    title: 'Your account',
    summary: 'One account for every tournament: your details, sign-in links and deleting it.',
    sections: [
      { heading: 'Signing up', todo: '18+, confirming your email, what the profile is used for.', screenshot: 'Sign-up form' },
      { heading: 'Logging in', todo: 'Password, Email me a sign-in link, the Home Screen app’s own login.' },
      { heading: 'Deleting your account', todo: 'What’s removed, what tournaments keep, when it’s refused (see the Privacy Policy).' },
    ],
  },
  {
    slug: 'first-tournament',
    audience: 'directors',
    title: 'Your first tournament',
    summary: 'From Create Tournament to registration open, step by step.',
    sections: [
      { heading: 'Create it', todo: 'Create Tournament, the details, venue, state and ball.', screenshot: 'Setup, first step' },
      { heading: 'Divisions', todo: 'Formats (round robin, pools to bracket, elimination), skill and age rules, team limits, merging small divisions.', screenshot: 'A division’s settings' },
      { heading: 'Prices and registration', todo: 'Registration and event fees, early prices, discount codes, questions, the refund policy, closing date.', screenshot: 'Registration settings' },
      { heading: 'Managers', todo: 'Adding managers and court monitors; what each can do.' },
      { heading: 'Open registration', todo: 'The setup fee, sharing the link, listing it on the Tournaments page.' },
    ],
  },
  {
    slug: 'payments',
    audience: 'directors',
    title: 'Payments, fees and refunds',
    summary: 'Players pay into your own Stripe account; Courtside’s fee comes out of each payment.',
    sections: [
      {
        heading: 'Connect Stripe',
        body: 'In Setup → Payments, tap Connect Stripe. Stripe asks for your business details and a bank account, and pays out to you directly. Only the tournament’s owner can connect it.',
        screenshot: 'Setup → Payments card',
      },
      { heading: 'What comes out of each payment', todo: 'Stripe’s card fee, Courtside’s per-player and texting fee, with a worked example (link to Pricing).' },
      { heading: 'Refunds', todo: 'Withdrawal credits, Refund to their card, keeping the refund fee, why Courtside’s and Stripe’s fees aren’t returned.', screenshot: 'Refund to their card' },
      { heading: 'Players who didn’t pay by card', todo: 'Why their fee is billed to you, paying it on the Finance page.' },
    ],
  },
  {
    slug: 'match-day',
    audience: 'directors',
    title: 'Running match day',
    summary: 'Check-in, the court desk, scores and fixing what goes wrong.',
    sections: [
      { heading: 'Check-in', todo: 'The Check-in page, self check-in QR code, late players and forfeits.', screenshot: 'Check-in page' },
      { heading: 'The court desk', todo: 'Starting divisions, calling matches, holding a court, the queue.', screenshot: 'Court desk' },
      { heading: 'Fixing things', todo: 'Correcting scores, reopening matches, substitutes and alternates, dropping and bringing back teams, moving teams between divisions.' },
      { heading: 'Paper backup', todo: 'Printing scoresheets and draws.' },
    ],
  },
  {
    slug: 'results-and-finance',
    audience: 'directors',
    title: 'Results, DUPR and finance',
    summary: 'Finish divisions, send results to DUPR and see where the money went.',
    sections: [
      { heading: 'Finishing divisions', todo: 'Making a division final, what changes after.' },
      { heading: 'DUPR', todo: 'Ratings refresh, division rules warnings, DUPR IDs, the results file.', screenshot: 'DUPR page' },
      { heading: 'The Finance page', todo: 'Each number on it and what’s still open.', screenshot: 'Finance page' },
    ],
  },
];

export const faq: { group: string; items: { q: string; a?: string }[] }[] = [
  {
    group: 'Players',
    items: [
      { q: 'Do I need an account to register?', a: 'No, but with one your details fill in and you can get match alerts.' },
      { q: 'How do I withdraw?', a: 'Open the link in your registration email and tap Withdraw. Refunds follow the tournament’s refund policy.' },
      { q: 'My partner hasn’t registered yet. Are we a team?' },
      { q: 'Why didn’t I get a text?' },
    ],
  },
  {
    group: 'Directors',
    items: [
      { q: 'What does Courtside cost?', a: 'A setup fee per tournament and a fee per player; see Pricing.' },
      { q: 'Where does the money go?', a: 'Into your own Stripe account. Courtside’s fee comes out of each payment.' },
      { q: 'Can I run a tournament registered somewhere else?' },
      { q: 'What happens if the internet goes down?' },
    ],
  },
];
