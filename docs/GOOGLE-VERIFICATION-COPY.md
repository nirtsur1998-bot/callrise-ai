# Google verification — ready-to-submit copy

**Written 2026-08-29** so the founder can submit without waiting on me.
Domain: **`callrise-ai.com`** (note the hyphen — `callrise.ai` is a different,
unregistered domain and must not appear anywhere in the submission).

Everything below is written to be **true of the code as it actually is
today**, not aspirational. Google's reviewer opens the app and checks. Where a
claim depends on something being true, the file and behaviour backing it is
named in a footnote so it can be re-checked before submitting.

---

## 1. Console fields (copy/paste)

| Field | Value |
|---|---|
| App name | `CallRise AI` |
| User support email | *(founder's address — must be one the Google account can receive at)* |
| App logo | 120×120 PNG, square, no rounded corners applied by you (Google rounds it) |
| Application home page | `https://callrise-ai.com/` |
| Application privacy policy link | `https://callrise-ai.com/privacy` |
| Application terms of service link | `https://callrise-ai.com/terms` *(optional but reduces reviewer questions)* |
| Authorised domain | `callrise-ai.com` |
| Developer contact information | *(same address as support, or a role address)* |

---

## 2. Scope justifications

Paste each into the "why do you need this scope" box for the matching scope.
Google's reviewer is checking two things: that the scope is *necessary* for a
user-visible feature, and that you aren't asking for more than you use.

### `https://www.googleapis.com/auth/calendar.readonly`

> CallRise AI is a desktop application for salespeople. It reads the signed-in
> user's own calendar to do three things they can see in the product: display
> their meetings in the app's Calendar screen; recognise that a meeting is
> currently running so a call the user records can be associated with the
> right meeting; and assemble a short pre-meeting brief from the user's own
> notes about that contact.
>
> Read access is the minimum required for all three, and it is what we request
> at first connect — the app has a distinct read-only mode and does not ask
> for write access unless the user separately turns on two-way sync.
>
> Calendar data is stored on the user's own computer. It is not sold, not used
> for advertising, and not used to train any model.

### `https://www.googleapis.com/auth/calendar.events`

> Requested only when the user explicitly enables two-way sync, as a second,
> separate authorisation — never at first connect.
>
> It allows the user to create, edit and delete their own calendar events from
> inside CallRise AI rather than switching to Google Calendar, and to set
> reminder lead times on those events so that Google delivers the reminder to
> whatever devices the user already uses.
>
> The app only ever writes events the user creates or edits in the app. It
> does not create events on the user's behalf, and it does not modify events
> it did not create except when the user edits one directly.

**Why this pairing is defensible:** the read-only-first design is genuine
least privilege and is worth pointing out in the submission notes — most
applications request write access immediately.

---

## 3. Privacy policy — full text

Publish at `https://callrise-ai.com/privacy`. Replace the two bracketed
placeholders before publishing.

---

### Privacy Policy — CallRise AI

*Last updated: [DATE]*

CallRise AI is a desktop application that helps salespeople prepare for,
record, and follow up on their sales calls. This policy explains what data the
application handles, where that data lives, and what it is never used for.

#### The short version

CallRise AI is a **local-first** application. Your calls, transcripts, notes,
contacts and calendar data are stored **on your own computer**. They are not
uploaded to us. Cloud backup exists but is **off unless you turn it on**.
Nothing you produce in CallRise AI is sold, used for advertising, or used to
train any AI model.

#### Google user data

If you choose to connect Google Calendar, CallRise AI requests access to your
calendar and uses it as follows.

**What we access**

- `calendar.readonly` — your calendar list and the events on it: titles,
  start and end times, descriptions, and attendee email addresses.
- `calendar.events` — requested **only** if you separately enable two-way
  sync. It permits creating, editing and deleting events.

**What we do with it**

- Show your upcoming meetings inside the application.
- Detect that a meeting is in progress, so a call you record can be associated
  with the correct meeting.
- Generate a pre-meeting brief, combining the meeting details with notes you
  have written yourself about that contact.
- With two-way sync enabled only: write events you create or edit in the app
  back to your Google Calendar, including any reminder times you set, so that
  Google delivers those reminders.

**Where it is stored**

Calendar data retrieved from Google is stored **on your own device**. It is
sent to no third party. If — and only if — you enable cloud backup, the data
you have chosen to back up is stored in our hosted database so it can be
restored to another machine of yours; it remains yours and is not shared.

**What we never do with it**

- We do not sell it, rent it, or share it with data brokers.
- We do not use it for advertising or profiling.
- We do not use it to train machine-learning models.
- We do not transfer it to others except as needed to provide a feature you
  have explicitly turned on.

**Limited Use**

CallRise AI's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

**Revoking access**

You can disconnect at any time from **Settings → Calendar → Disconnect** in
the application, which deletes the stored credential from your device. You can
additionally revoke access from your Google Account at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

#### Artificial intelligence features

Some features (call summaries, coaching suggestions, prep briefs) send text to
an AI provider. **You supply your own API key** for the provider you choose,
and the request goes from your computer to that provider directly. Which
provider handles which task is shown, and configurable, in Settings. Your
Google calendar data is included only where it is part of the feature you
invoked — for example the meeting title in a prep brief.

#### Call recordings and transcripts

Recordings and transcripts are created and stored on your own device. Consent
requirements for recording other parties vary by jurisdiction; CallRise AI
provides disclosure tooling but responsibility for lawful recording rests with
you.

#### Diagnostics

Anonymous crash and health reporting is **off by default**. If you turn it on,
it sends technical events only — never your calls, transcripts, notes, keys,
or calendar contents. You can view exactly what would be sent, and what has
been sent, in Settings → Diagnostics & telemetry.

#### Children

CallRise AI is a business tool and is not directed to anyone under 16.

#### Changes

Material changes to this policy will be reflected here with an updated date.

#### Contact

[CONTACT EMAIL]

---

## 4. Homepage — minimum viable copy

Google requires the homepage to describe the app and be on the same domain.
It does not need to be elaborate; it needs to be real and consistent with what
the consent screen says.

> ### CallRise AI
> **A sales assistant that runs on your own computer.**
>
> CallRise AI records your sales calls, transcribes them, and turns them into
> summaries, coaching feedback and follow-up tasks — with your calls, notes
> and contacts stored on your own machine rather than in someone else's cloud.
>
> **Calendar integration.** Connect Google Calendar or Outlook to see your
> meetings in the app, get a prepared brief before each one, and — if you turn
> on two-way sync — create and edit events without leaving CallRise AI.
>
> **Bring your own AI.** You choose the AI provider and supply your own key.
>
> [Privacy Policy](https://callrise-ai.com/privacy) · [Terms](https://callrise-ai.com/terms) · [Contact](mailto:CONTACT)

---

## 5. Before submitting — re-check these claims

The policy above asserts things about the code. Confirm each is still true at
submission time; a reviewer who finds one false can reject the whole
application:

- [x] Cloud backup is genuinely off by default — **verified 2026-08-29**:
      `DEFAULT_SETTINGS.syncScope = EMPTY_SYNC_SCOPE`, in which all six
      scopes (transcripts, attachments, knowledgeBase,
      settingsPersonalization, contacts, salesBrain) are `false`.
- [x] Telemetry is off by default — **verified**: consent-gated, and opt-out
      erases stored events (BUG-090 / M29 A1).
- [x] The first Google connect requests **read-only**, and write access is a
      separate action — **verified**: `google:connect` uses `SCOPES_RO`,
      `google:connectWrite` uses `SCOPES_RW` (`google.ts:678-679`).
- [x] Disconnect deletes the stored token — **verified**: `disconnect()` also
      calls Google's `revokeToken` first, so the grant is revoked at Google
      rather than merely forgotten locally (`google.ts:252-260`). Worth
      mentioning in the submission: it is stronger than what most reviewers
      expect.
- [ ] The support email is one the Google account can actually receive at.
- [ ] Homepage, privacy policy and terms are all live on `callrise-ai.com`
      **before** clicking submit — Google fetches them during review.
