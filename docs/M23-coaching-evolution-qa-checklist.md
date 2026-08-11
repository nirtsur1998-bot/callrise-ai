# M23 Coaching Evolution Engine + Contact Intelligence — manual QA checklist

This milestone touches no native/audio code, so every step below is
identical on Windows and macOS — no separate platform sections needed.

Every capability in this milestone is behind its own settings flag, **off
by default**. Section 0 verifies that baseline before turning anything on.
Check off each item; anything that fails goes back with the exact repro
(which call, what you clicked, what you expected vs. what happened).

## 0. Baseline — everything off by default

- [ ] `npm run build` succeeds with zero errors.
- [ ] On a fresh profile (or after Settings → reset), Settings shows:
      Coach 2.0 OFF, CRM Note Generator OFF, Contact Intelligence set to
      Off.
- [ ] With everything off, a normal call — record, transcribe, coach,
      summarize — looks and behaves exactly as it did before this
      milestone. No new cards, buttons, or banners appear anywhere.

## 1. Coach 2.0 (skill-building engine)

Turn on Settings → Coaching → Coach 2.0.

- [ ] Coach a call. The scorecard now shows a Skill Graph (8 skills,
      0–100 each) and a detected call type (cold-call/discovery/demo/
      closing) alongside the existing scorecard — nothing from the old
      scorecard is missing or reordered.
- [ ] Pick a methodology (e.g. MEDDIC) in Settings, then coach a new call
      — the report's language should visibly reflect that lens, not a
      generic blend.
- [ ] Progress dashboard shows trend lines building up as you coach more
      calls for the same "rep" (your own account).
- [ ] Focus Skill: after a few calls, confirm one skill is highlighted as
      the current focus with a specific micro-behavior to practice — and
      that it does NOT change on every single call (only after a
      sustained streak of improvement).
- [ ] Turn Coach 2.0 back OFF, coach one more call — confirm the report
      reverts to the plain six-dimension scorecard with no skills section.

## 2. Coaching Chat (advisor + practice mode)

No separate setting — this ships live on any coached call's detail page
("Ask your coach" card).

- [ ] Ask a question about a specific call (e.g. "what should I have said
      differently?"). Reply streams in token-by-token, not all at once.
- [ ] Switch to Practice mode, have a short back-and-forth roleplaying the
      buyer, then click **End practice**. Confirm you get real coaching
      feedback (not another in-character buyer line).
- [ ] **Regression-check the critical bug found in review:** after ending
      practice, immediately ask a normal advisor question in the same
      chat. Confirm it gets a real answer — this exact sequence used to
      corrupt the thread and silently break every later reply.
- [ ] From the chat: draft a follow-up email, add a task, and (if the
      call has a linked contact) regenerate the CRM note — all three
      should produce real, call-specific content, not boilerplate.
- [ ] If a save-worthy fact comes up in chat (e.g. "actually the budget
      is $80k"), confirm a suggestion chip appears and nothing is saved
      until you tap it.

## 3. CRM Note Generator

Turn on Settings → CRM → CRM Note Generator.

- [ ] Open a contact with at least one linked call. A "Generate CRM
      note" card appears with a Short/Medium/Detailed toggle.
- [ ] Generate at each of the three lengths — confirm they're actually
      different lengths, not near-identical text with padding.
- [ ] Save a generated note — confirm it appears in the contact's
      Comments list immediately (marked AI-drafted), without a manual
      page refresh.
- [ ] If any KYC fact suggestions appear, accept one and confirm the chip
      shows a clear "✓ Updated" state (not just disappearing).
- [ ] Try a contact with **no** linked calls — confirm the card shows a
      clear "link a call first" message, not a silent failure or crash.
- [ ] Turn the setting back OFF — confirm the card disappears from every
      contact page.

## 4. Contact Intelligence

### 4a. Outlook calendar-match fix (no setting — always on)

- [ ] With Outlook connected and an Outlook meeting that matches a call's
      time, open that call — confirm the "matches your calendar" banner
      now appears (previously this only ever worked for Google Calendar
      meetings).
- [ ] Confirm Google-only users see no change in behavior — same banner,
      same matches as before.

### 4b. Detection modes

Settings → CRM → Contact Intelligence, try each mode on a genuine
one-on-one call with **buyer-recording consent granted** and no linked
contact:

- [ ] **Off:** no "Detect who this was" button, no detected-name banner,
      anywhere.
- [ ] **Suggest:** a "Detect who this was" button appears. Click it — if
      the other person stated their name on the call, a "Detected
      [name]" banner appears with a Create/Link button; if they never
      said it, you see a clear "No self-introduction found" message
      (not silence).
- [ ] **Full-auto:** open a fresh, eligible call — detection runs on its
      own within a second or two of the page loading, no click needed.
      **Confirm creating/linking a contact still always requires your
      own click, in every mode** — this must never happen by itself.
- [ ] On a call **without** buyer-recording consent, confirm the button
      simply doesn't appear (Suggest mode) and full-auto doesn't run or
      show any alarming error — this call is just quietly ineligible.
- [ ] Dismiss a detected-name banner ("X"), then separately trigger (or
      already have) a calendar-match banner on a *different* call —
      confirm dismissing one never silently suppresses the other on an
      unrelated call, and doesn't suppress a LATER calendar match on the
      *same* call either.
- [ ] Detect a name, click "Create contact," then have the *same* person
      detected again on a second call with no calendar invite — confirm
      it offers to **link** the existing contact rather than creating a
      duplicate.
- [ ] Turn Contact Intelligence back to Off — confirm every button/banner
      from this section disappears.

## 5. Regression pass

- [ ] Full existing flow untouched: record → transcribe → coach →
      summarize → link contact → generate tasks, all with every setting
      above OFF, works exactly as before.
- [ ] `npx vitest run` — full suite green (1102+ tests at time of
      writing).
