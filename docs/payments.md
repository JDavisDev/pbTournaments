# Payments (Stripe Connect)

Players pay **into the director's own Stripe account**. Courtside never holds tournament money.

- Each organization connects a Stripe account (Setup → **Payments** → **Connect Stripe**), owners and admins only. Stripe's hosted form collects their business details and bank account.
- Each registration is a **direct charge** on that account. The director is the seller: Stripe's card fee, refunds, disputes and the tax form (1099-K) are theirs.
- **Courtside's fee** (per player, plus texting when it's on, from `private.platform_pricing`) comes out of each payment as Stripe's *application fee*. It counts the registrant and any partner they paid for, and never exceeds the payment. Registrations keep `platform_fee_cents`.
- The **setup fee** is still paid to Courtside's own Stripe account (`/api/checkout/setup`).
- **Refunds** go through Courtside: Players → a player → **Refund to their card**, up to what they're owed (a withdrawal credit, or a credit the director adds). The refund goes back on Stripe, on the director's account, to the card payments it came from (newest first), and is recorded on the books with Stripe's refund id. **Courtside never loses money on a refund:** its fee from the payment isn't refunded (`refund_application_fee` stays off) and Stripe keeps its card fee, so the tournament covers both. The tournament can also keep its refund fee (Setup), recorded as a `fee`. Refunds made straight in the Stripe dashboard aren't seen by Courtside: record those as "Refunded another way".
- **Players who didn't pay by card** (added at the desk, free entries, cash): Courtside's per-player fee couldn't come out of a payment, so the director pays it from the **Finance** page (`/api/checkout/fees`, to Courtside's own Stripe account). `private.uncovered_players` counts players on a team that no paid card registration covered (their own, or a partner's who paid for them).
- **Finance page** (`/t/<id>/finance`, More → Finance): card and desk payments, refunds, Courtside and (estimated) Stripe fees, what's left after fees, who still owes or is owed, fees due, and players by division.

## Without Stripe keys (local mode, the demo site)

**Connect Stripe** connects a pretend account (`acct_test_…`) at once, and the test checkout stands in for Stripe. Nothing is charged. Once real keys are set, a pretend account is replaced the next time the owner clicks **Connect Stripe**.

## Setup

1. In Stripe, turn on **Connect** for Courtside's account (Settings → Connect). Choose **Standard** accounts (directors get their own full Stripe dashboard).
2. Set `STRIPE_SECRET_KEY` (an `sk_test_` key while testing).
3. Two webhooks, both to `https://<site>/api/stripe/webhook`:
   - **Your account:** `checkout.session.completed` (setup and player fees) → `STRIPE_WEBHOOK_SECRET`.
   - **Connected accounts:** `checkout.session.completed`, `account.updated` → `STRIPE_CONNECT_WEBHOOK_SECRET`.
4. Locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook --forward-connect-to localhost:3000/api/stripe/webhook`.

Onboarding: `/api/connect/onboard` creates the account and a Stripe Account Link; Stripe sends the owner back to `/api/connect/return`, which reads the account's status. `account.updated` keeps it current. Checkout refuses card payments until the account can take charges.
