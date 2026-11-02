# Home Screen and match alerts

## Add to Home

Every page has **Add to Home** at the top right on phones (Android, iPhone). The button hides once the site runs from the Home Screen.

- **Android / Chrome:** the browser's own install prompt.
- **iPhone (Safari or Chrome):** there is no prompt, so the button shows the steps: Share → Add to Home Screen → Add.

The site has an app manifest (`web/src/app/manifest.ts`), icons (`web/public/icon-*.png`) and a service worker (`web/public/sw.js`) that caches nothing, so pages are never stale.

## Match alerts

Signed-in players turn on **Match alerts** on their profile or after registering. When a text is queued for one of their players (court calls, court changes, division started, messages from the desk), it goes to their phones as a notification instead, and tapping it opens the score link. The Messages page shows it as **App alert**. Players without alerts get the text as before.

- A phone belongs to an account. An account's players are those linked to it, or with its email (as for self check-in).
- **iPhone:** only once the site is on the Home Screen and opened from there (iOS 16.4 or later). The card says so and shows the steps.
- Alerts are free and have no delivery reports: a sent alert can still go unseen on a muted phone.
- A match call expires after 15 minutes if the phone is off.
- Alerts go out with the text outbox (`/api/texts/send`), so a live site needs that scheduled the same as texts. Local mode sends automatically.

### Setup

1. `npx web-push generate-vapid-keys`
2. Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (server only) in `web/.env.local` and on the host. Changing them later means everyone turns alerts on again.
3. Optional: `VAPID_SUBJECT` (default `mailto:` the support address).

**Send a test alert** on the profile checks the setup end to end.
