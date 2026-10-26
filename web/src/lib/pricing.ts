// The pricing calculator's math: what players pay, where each dollar goes,
// and what the director keeps. Platform prices come from the database
// (platform_pricing()); card processing is Stripe's standard US rate.

import type { PlatformPricing } from './types';

/** Stripe's standard US card rate, charged on each player's checkout. */
export const CARD_PERCENT = 0.029;
export const CARD_FIXED_CENTS = 30;

/** PickleballTournaments.com's published fees (plan for tournaments opened from Aug 3, 2026). */
export const PT = { perRegistrationCents: 500, percent: 0.0799, setupCents: 2500, textingPerPlayerCents: 25 };

export interface PricingInputs {
  players: number;
  /** Dollars. */
  entryFee: number;
  extraEventFee: number;
  /** Average extra events per player (0 = everyone plays one event). */
  extraEvents: number;
  texting: boolean;
  /** Add the fees to the price players pay, so the director keeps the full entry. */
  passToPlayers: boolean;
}

export interface PricingResult {
  /** What each player is charged, in cents. */
  playerPays: number;
  /** The entry before any fees, per player. */
  baseEntry: number;
  perPlayer: { director: number; card: number; platform: number };
  totals: {
    collected: number;
    card: number;
    setup: number;
    playerFees: number;
    texting: number;
    platform: number;
    director: number;
  };
  /** PT's fees on the same registrations (card processing may be extra there). */
  ptFees: number;
}

const cents = (dollars: number) => Math.round(dollars * 100);
const card = (amount: number) => Math.round(amount * CARD_PERCENT) + CARD_FIXED_CENTS;

export function calculate(inputs: PricingInputs, pricing: PlatformPricing): PricingResult {
  const n = Math.max(1, Math.floor(inputs.players));
  const baseEntry = cents(inputs.entryFee) + Math.round(cents(inputs.extraEventFee) * Math.max(0, inputs.extraEvents));
  const platformPerPlayer = pricing.per_player_cents + (inputs.texting ? pricing.texting_per_player_cents : 0);

  // Passing fees on: the price that leaves the director the full entry after
  // card processing, the platform fee and a share of the setup fee.
  const playerPays = inputs.passToPlayers
    ? Math.ceil((baseEntry + platformPerPlayer + CARD_FIXED_CENTS + pricing.setup_fee_cents / n) / (1 - CARD_PERCENT))
    : baseEntry;

  const cardPerPlayer = card(playerPays);
  const collected = n * playerPays;
  const totals = {
    collected,
    card: n * cardPerPlayer,
    setup: pricing.setup_fee_cents,
    playerFees: n * pricing.per_player_cents,
    texting: inputs.texting ? n * pricing.texting_per_player_cents : 0,
    platform: 0,
    director: 0,
  };
  totals.platform = totals.setup + totals.playerFees + totals.texting;
  totals.director = collected - totals.card - totals.platform;

  return {
    playerPays,
    baseEntry,
    perPlayer: {
      card: cardPerPlayer,
      platform: platformPerPlayer + Math.round(pricing.setup_fee_cents / n),
      director: playerPays - cardPerPlayer - platformPerPlayer - Math.round(pricing.setup_fee_cents / n),
    },
    totals,
    ptFees:
      n * PT.perRegistrationCents +
      Math.round(collected * PT.percent) +
      PT.setupCents +
      (inputs.texting ? n * PT.textingPerPlayerCents : 0),
  };
}
