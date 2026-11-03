# Stripe integration: what's left

Courtside already uses Stripe's hosted Checkout, so the Checkout Studio settings went into the existing sessions. Nothing new was added. The full payments design (Connect, fees, refunds) is in [docs/payments.md](docs/payments.md).

## Values to Replace

None. Every value the setup prompt called a placeholder already has a real value in the code:

**Files checked:**
- [web/src/server/payments.ts](web/src/server/payments.ts)

| Field | Current Value | Why it stays |
|-------|--------------|-------------|
| mode | `payment` | Registrations and fees are one-time payments. |
| success_url | Registration: `/t/<id>/register/done?r=<registration>`. Setup fee: `/t/<id>/setup?setup=paid`. Player fees: `/t/<id>/finance?fees=paid` | Real pages. The webhook confirms the payment, so the session ID isn't needed in the URL. |
| cancel_url | `/t/<id>/register?cancelled=1`, `/t/<id>/setup`, `/t/<id>/finance` | Real pages. |
| line_items | Built per checkout with `price_data` (the amount owed, named after the tournament) | Each amount differs (entries, extra events, partners, discounts), so there are no fixed Price IDs to create. |

## Configured Parameters

These came from Checkout Studio. They're set once in `checkoutSettings` and used by all three sessions: player registration, the setup fee and the player-fees payment.

**Files containing these parameters:**
- [web/src/server/payments.ts](web/src/server/payments.ts)

| Parameter | Value |
|-----------|-------|
| ui_mode | `hosted_page` (Stripe SDK 23.0.1) |
| billing_address_collection | `auto` |
| phone_number_collection | `{ enabled: false }` |
| automatic_tax | `{ enabled: false }` |
| allow_promotion_codes | `false` (Courtside has its own discount codes, applied before checkout) |
| submit_type | `auto` |
| integration_identifier | `hosted_web_0001` |
| origin_context | `web` |

`payment_method_collection` (`always`) is left out, because Stripe allows it only on subscriptions.

The prompt said to remove every other parameter. These were kept because payments depend on them:
- `metadata` and `payment_intent_data.metadata`: how the webhook finds the registration or tournament that was paid.
- `payment_intent_data.application_fee_amount`: Courtside's fee on each registration.
- `expires_at`: a checkout closes when the registration's 30-minute hold on its spots ends.
- `customer_email`: fills in the player's email.
- The connected account (`stripeAccount`): registrations are direct charges on the director's own account.

## Setup

### Environment variables (Vercel → Settings → Environment Variables)

| Name | Value |
|------|-------|
| `STRIPE_SECRET_KEY` | `sk_test_…` while testing, `sk_live_…` once live |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the **Your account** webhook |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret of the **Connected accounts** webhook |
| `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API Keys. The webhook uses it to mark payments. |

- **No publishable key:** hosted Checkout doesn't use one.
- **Demo mode:** remove `NEXT_PUBLIC_DEMO_MODE`, or payments always use the built-in test checkout.
- **Redeploy** after changing any of these.

### Stripe dashboard

1. **Turn on Connect:** Settings → Connect, with **Standard** accounts.
2. **Add two webhooks,** both to `https://courtsidetournaments.com/api/stripe/webhook`:
   - **Your account:** `checkout.session.completed`
   - **Connected accounts:** `checkout.session.completed` and `account.updated`
3. **Database:** run `npx supabase db push` so the payment tables and functions exist.

### Local testing

Put the same variables in `web/.env.local`, then run:

```
stripe listen --forward-to localhost:3000/api/stripe/webhook --forward-connect-to localhost:3000/api/stripe/webhook
```

It prints a `whsec_` secret to use for both webhook variables.

## How it works

1. **Connect:** a director clicks **Connect Stripe** in Setup and finishes Stripe's onboarding. `account.updated` records when the account can take payments.
2. **Register:** a player registers and is sent to Checkout, on the director's account. Courtside's fee comes out as the application fee.
3. **Confirm:** `checkout.session.completed` marks the registration paid. It counts only if the money went to the account the checkout was started on.
4. **Courtside's own fees:** the setup fee and fees for players who didn't pay by card are separate checkouts, paid to Courtside's own account.
5. **Refunds:** these go through Courtside (Players → a player → **Refund to their card**). They're made on the director's account, and Courtside keeps its fee.

## Testing

Use a Sandbox key (`sk_test_…`). Test cards:

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0025 0000 3155` | Asks for 3D Secure authentication |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

Use any future expiry date, any CVC and any ZIP. A sandbox director can finish Connect onboarding with Stripe's test details (for example SSN `000-00-0000` and routing number `110000000`).

## Next steps

- **Going live:**
  1. Swap in `sk_live_…`.
  2. Recreate both webhooks in live mode and update their secrets.
  3. Redeploy.
- **After the switch:**
  - Directors who connected during testing must click **Connect Stripe** again, because sandbox accounts don't exist in live mode.
  - Delete the test tournaments, so their sandbox payments don't sit in Finance next to real ones.
- **Branding:** each director sets their logo and colors in their own Stripe account (Settings → Branding). Checkout shows their name, since they're the seller.
- **Sales tax:** `automatic_tax` is off. If a director needs Stripe Tax, it has to be turned on in their account and in this setting.

## Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
