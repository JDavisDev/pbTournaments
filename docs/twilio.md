# Texting with Twilio

Players get a text each time their match is called to a court, e.g.

> Your match is ready on COURT 9 versus Park/Cho. One game to 15, win by 2. Promptly report your scores here: https://…/s/k3j9x when finished.

Without Twilio keys every text is written to the **Messages** page instead of being sent (the "Test log"). Nothing below is needed for local testing.

## 1. Account and number

1. Create a Twilio account and upgrade it from trial. A trial account only texts numbers you've verified in the console, and puts "Sent from your Twilio trial account" in front of every message.
2. Buy a number. Two choices for US texting:
   - **Toll-free number** (recommended for a gym): submit **toll-free verification** (Console → Messaging → Regulatory compliance). It usually takes a few days to a few weeks. Until it's approved, carriers block the texts (Twilio error 30032).
   - **Local number**: needs **A2P 10DLC** registration (a brand and a "campaign"). Unregistered local numbers are blocked (error 30034).
   For either form, describe the use as "transactional notifications to tournament players who opted in at registration: court assignments and score-report links". Registration already has the opt-in checkbox with "Reply STOP to opt out".
3. Optional: put the number in a **Messaging Service** and use its SID instead of the number. Twilio then handles STOP/HELP replies and sender pools for you.

## 2. Settings

In `web/.env.local` (or the hosting provider's environment settings):

| Setting | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | `AC…` from the Twilio console |
| `TWILIO_AUTH_TOKEN` | The auth token (server only, never in `NEXT_PUBLIC_…`) |
| `TWILIO_FROM_NUMBER` | The number in +1 format, e.g. `+18005550123` |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional, `MG…`; used instead of the number when set |
| `NEXT_PUBLIC_APP_URL` | The site's public `https://` address. Used for score links and for delivery reports |
| `SMS_MODE=log` | Optional: keep logging even with keys set |

Restart the server after changing them.

## 3. Delivery reports

Each text is sent with a `StatusCallback` to `NEXT_PUBLIC_APP_URL/api/twilio/status`. Twilio posts there as the text moves through queued → sent → delivered (or undelivered/failed). The route checks Twilio's `X-Twilio-Signature` with the auth token, then stores the status on the message.

Twilio can't reach `localhost`, so delivery reports only work on the deployed site, or locally through a tunnel (set `NEXT_PUBLIC_APP_URL` to the tunnel's https address).

## 4. Checking it works

The **Messages** page has a **Texting** panel:

- **Twilio live / Test log / Problem**: whether texts are really being sent, and whether Twilio accepted the keys.
- **Sender, Account, Reports**: the number (masked), Trial or Full account, and whether delivery reports are on.
- Warnings for a trial account, the magic test number, or no delivery reports.
- Counts of delivered / sent / failed texts, and the most common reasons texts didn't arrive (e.g. "30007: filtered as spam by the carrier", "Player did not opt in to texts", "No phone number").

The log below it can be filtered to **Problems** (failed or not sent) and searched by name, phone or text.

A quick end-to-end check before an event:

1. Register yourself in a test division with your own phone and texts on.
2. Check yourself in and start the division (that builds its schedule).
3. When the match is called you should get the text; the log shows **Sent**, then **Delivered** a few seconds later.
4. Open the link in the text and report a score.

## Test credentials

Twilio's **test credentials** (Console → Account → API keys & tokens → Test credentials) accept messages without sending them or charging. Use them as `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` with the magic sender `TWILIO_FROM_NUMBER=+15005550006`. Twilio sends no delivery reports for test messages, so the log stays at **Sent**.

## Common errors

| Code | Meaning | Fix |
|---|---|---|
| 21610 | The player replied STOP | They have to text START to opt back in |
| 21211 / 21614 | Not a valid mobile number | Fix the number on the Players page |
| 30003 | Phone off or out of service | Nothing to do; tell them at the desk |
| 30005 / 30006 | Unknown number, or a landline | Fix the number |
| 30007 | Carrier filtered it as spam | Finish toll-free verification / 10DLC registration |
| 30032 | Toll-free number not verified | Wait for, or fix, the toll-free verification |
| 30034 | Local number not registered for 10DLC | Register the brand and campaign |
