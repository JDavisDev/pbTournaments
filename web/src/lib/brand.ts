// The product name in one place, so renaming is a one-line change.
export const BRAND = {
  name: 'Courtside',
  /** The second line of the logo. */
  descriptor: 'Tournaments',
  tagline: 'Run the whole tournament from one screen.',
  /** Who owns the product, and the year it was first published (the footer's copyright line). */
  owner: 'Rocket Ventures, LLC',
  /** The registered trade name the owner does business as. */
  tradeName: 'Courtside',
  since: 2026,
  /** Where questions about the Terms and Privacy Policy go. Set up this address before launch. */
  contactEmail: 'support@courtsidetournaments.com',
  domain: 'courtsidetournaments.com',
  /** The Terms and Privacy Policy's effective date (YYYY-MM-DD); change it with them. */
  legalUpdated: '2026-11-02',
};

/** Who the Terms and Privacy Policy are with: "Rocket Ventures, LLC d/b/a Courtside". */
export const OPERATOR = `${BRAND.owner} d/b/a ${BRAND.tradeName}`;
