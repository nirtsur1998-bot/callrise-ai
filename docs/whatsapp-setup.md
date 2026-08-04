# WhatsApp alerts — setup (not yet enabled)

WhatsApp is scaffolded in M19 Task 1 — the adapter (`src/main/alert-channels/whatsapp.ts`)
and dispatcher wiring are fully written and call the real Meta Cloud API — but it is
**disabled in the UI** ("Coming soon") because it needs steps only the account owner can
do, outside this codebase. This doc is the checklist for turning it on later.

## Why this can't just be "turned on"

Unlike Telegram (a bot token) or email (an API key), WhatsApp Business messaging has two
real gates:

1. **Meta Business verification** — your business must be verified with Meta before you
   can send anything beyond a small test allowance.
2. **Template approval** — WhatsApp forbids sending a business-initiated message outside
   a 24-hour customer-service window unless it uses a **pre-approved message template**.
   A meeting/task reminder is exactly this case (the user isn't actively messaging the
   bot when the reminder fires), so every alert this feature sends must go through an
   approved template — not free-form text.

## Steps

1. **Create a Meta Business Account** (business.facebook.com) if you don't have one.
2. **Add a WhatsApp Business Platform app** in [Meta for Developers](https://developers.facebook.com/)
   → create an app → add the "WhatsApp" product.
3. **Verify your business** — Meta Business Suite → Business Settings → Business Info →
   Verify. This can take anywhere from same-day to a couple of weeks; do this first since
   everything else is blocked on it.
4. **Register a phone number** for the WhatsApp Business API (a NEW number, not your
   personal WhatsApp — once a number is registered to the Cloud API it can no longer be
   used in the regular WhatsApp app). Meta for Developers → WhatsApp → API Setup.
5. **Submit the reminder template for approval** — Meta for Developers → WhatsApp →
   Message Templates → Create Template. Category must be **Utility** (a scheduling
   reminder is not "Marketing" and definitely not "Authentication"). Draft text:

   > **Template name:** `callrise_reminder`
   > **Category:** Utility
   > **Language:** English (or your primary language — submit one template per language
   > you need)
   > **Body:**
   > ```
   > CallRise AI reminder: {{1}}
   >
   > {{2}}
   > ```
   > Where `{{1}}` is the alert title (e.g. "Meeting starting in 10 minutes") and `{{2}}`
   > is the body (e.g. "Acme Corp — Q3 renewal call"). Keep variables to short plain text;
   > Meta's review rejects templates with formatting that looks like it's trying to smuggle
   > a different message per recipient beyond simple substitution.

   Approval is typically minutes to a few hours once your business is verified, but can be
   rejected — read Meta's rejection reason literally and resubmit; don't guess.

6. **Get your credentials** once verified + template approved:
   - `WHATSAPP_PHONE_NUMBER_ID` — from WhatsApp → API Setup → the registered number.
   - `WHATSAPP_ACCESS_TOKEN` — a permanent access token (System User token, not the
     24-hour temporary one shown by default) from Business Settings → System Users.
7. **Set the two env vars** in the app's `.env` (or wherever `WHATSAPP_PHONE_NUMBER_ID`/
   `WHATSAPP_ACCESS_TOKEN` are read from — see `src/main/alert-channels/whatsapp.ts`).
   Once both are set, `whatsAppStatus()` reports `configured: true` and the "Coming soon"
   badge can be removed from the channel picker in
   `src/renderer/src/features/alerts/AlertRulesCard.tsx`.
8. **Update `sendWhatsAppTemplate`'s caller** in the dispatcher to pass `callrise_reminder`
   as the template name with the two body variables — the function signature already
   expects exactly this shape.

## What's already done, so this is a flag flip once the above is complete

- The adapter's `sendWhatsAppTemplate()` call is fully written against the real Meta
  Graph API endpoint (`/​<phone-number-id>/messages`), including the template/components
  shape Meta expects.
- `whatsAppStatus()` is wired into the IPC layer (`alerts:channels:whatsappStatus`) so the
  UI already knows to grey out the option until both env vars are present.
