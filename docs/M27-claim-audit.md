# 1.3.0 — Claim audit

**Every claim this release rests on, how it was verified, and whether that verifier has ever been seen to REFUSE.**

Written before the founder's manual QA pass, on the principle that after nineteen catalogued species of hollow verification, the danger is not in what we checked — it is in what we are currently *holding as true* without having watched its check fail.

A verifier's first green is meaningless until you have seen its red. That now applies to **claims**, not just tools: *"it worked in an earlier version"* is inheritance, not verification.

---

## Amendment (2026-08-15) — "red-checked" is two confidence levels, not one

Taxonomy **species 20** landed after this table was first written, and it changes how a row may describe itself.

During the 1.2.6 hotfix, a red check came back **all-green**. Read at face value that means "these tests are hollow". It was not that: **the revert had silently failed to apply**, so the suite was green because the code was still correct. A red check returning green has two explanations — hollow tests, or a reversion that never happened — and they produce byte-identical output.

Therefore, every row below claiming "red-checked" must now say **which**:

| Level | Meaning |
|---|---|
| **Reversion confirmed** | The fix was removed, its absence verified in the file, and the check then failed for the right reason |
| **Reversion not verified** | The check was run after an edit whose application was never independently confirmed |

**Most red checks in this session are the second kind.** They are not thereby wrong — the fixes are almost certainly correct, and several were confirmed by other means (a control run, an independent assertion disagreeing, a natural control build). But the distinction is real and it is exactly the inherited-verification problem this audit exists to surface, turned on the audit's own primary instrument.

**Confirmed-reversion rows** (the revert's application was checked, or a genuine independent control existed):
- Row 11, migration 003 — a data-destroying migration was inserted and the test failed on it.
- Row 3, bundle verification — the staleness gate was proven to refuse a real stale artifact, and the 1.2.6 structural assertion was proven not to match the 1.3.0 control build, which genuinely lacks the fix.
- The 1.2.6 consent-lifetime fix — the failed revert was caught, re-applied, verified absent from the file, and *then* produced 3 red / 4 green.

**Everything else in the table should be read as "reversion not verified".** Not re-run, by decision — but recorded rather than left implied.

---

## The table

| # | Claim | How verified | Verifier seen red? | Confidence |
|---|---|---|---|---|
| 1 | The full suite passes (192 files, 1906 tests) | `npm test` → `run-tests.mjs`, real exit code read with nothing appended | **Yes.** `npm run verify:runner` breaks exit propagation on purpose and the runner correctly fails. It also went genuinely red twice today — BUG-070, and 4 wording tests | **High** |
| 2 | Typecheck is clean | `npm run typecheck` (the project's own composite command), exit read directly | **Yes.** Caught an invalid `MemoryCategory` in a brand-new fixture, and 6 missing-import errors in `backfill.ts` today | **High** |
| 3 | The packaged app contains the fixes | `scripts/verify-bundle.sh` — staleness gate + 16 content assertions on the extracted asar | **Yes, both halves, today.** Gate refused a stale artifact (exit 3); assertions independently reported 6 MISSING against that same artifact | **High** once run against the fresh asar |
| 4 | **Buyer words are stripped from journals when consent is declined (BUG-062)** | Founder's manual check on a real recorded call — **once, on 1.2.5** — plus automated tests | Automated: yes. Manual: a single positive observation | **LOW for 1.3.0** ⚠️ |
| 5 | Consent survives a mid-call buyer-capture restart (BUG-063) | Unit tests over the re-keyed gate | Red-checked when built | **Medium** — never exercised on real audio hardware ⚠️ |
| 6 | Cancellation reaches the actual work (BUG-060) | Per-adapter proof in M26 | Inherited from M26 | **Medium-high** — the invalidating condition was checked: **zero** new production `registerType` calls in 1.3.0 |
| 7 | Deferral holds only AI-dependent jobs (BUG-071) | 5 scheduler tests + 6 new tests against the **real** cooldown machinery | **Yes.** Reverting the gate fails 4 of 5, and the one that passes is the deliberate control | **High** |
| 8 | Sales Brain import completes on an exhausted key (BUG-072) | 3-run integration through the real `runBackfill` and a real migrated DB | **Yes.** Reverting makes run 2 re-extract calls it had already learned from | **Medium-high** — extraction is mocked; never proven against a real exhausted key ⚠️ |
| 9 | The window appears regardless of Sales Brain init (BUG-069) | 3 ordering tests + 1 characterisation test | **Yes.** Old shape fails 3; the naive fix fails 1 | **Medium** — models ordering via an injected trigger; never exercises real `ready-to-show`, cannot reproduce the slow-disk condition ⚠️ |
| 10 | A failed job-state save is logged, not lost (BUG-070) | Dedicated test with two independent witnesses | **Yes.** Reverting sends the rejection to the process-wide net | **High** |
| 11 | Migration 003 is backward compatible | Test against a DB built at the **previous** schema, carrying real rows | **Yes** — a deliberately data-destroying migration makes it fail (`expected 0 to be 1`) | **High** |
| 12 | The Activity button drags and stays on screen | Pure geometry unit tests | Not red-checked | **Medium** — real pointer, resize and click-vs-drag behaviour untested ⚠️ |
| 13 | The replaced AI catalog entries are correct (B2) | Checked against OpenRouter's live API **at the time** | Point-in-time, inherited | **Medium** — a live API can change under us ⚠️ |
| 14 | Wait times read as human text (BUG-073) | 6 unit tests over a pure function | Not red-checked (new pure function; trivially discriminating) | **High** |
| 15 | **1.3.0 works on a clean Windows machine** | **Nothing. Never attempted.** | n/a | **NONE** ⚠️⚠️ |

---

## The flagged rows, and what they mean

**⚠️ Row 15 — the biggest unknown by a distance.** No version of 1.3.0 has ever run on a machine without Visual Studio and Node.js. This is precisely the gap that produced four consecutive hotfixes after 1.2.0, and neither the suite nor CI can close it: both run where the dependencies already exist. Only the clean-install box establishes it.

**⚠️ Row 4 — the most dangerous inheritance.** The founder verified journal redaction manually on 1.2.5, against real recorded audio. That verification does **not** transfer, because 1.3.0 changed the consent machinery underneath it:

| File | Change in 1.3.0 |
|---|---|
| `consent-gate.ts` | +32 lines — BUG-063 re-keyed active consent from session id to call id |
| `live/call-journal.ts` | +48 lines |
| `live/live-transcript-ipc.ts` | +31 lines |
| `calls-fs.ts` | +5 lines |

Both commits (`d4e8922`, `cea1304`) are Phase 1 work landing *after* the manual check. The automated tests cover the new behaviour, but the thing that was verified against real audio was the *old* keying. This is the row where "verified once, on an earlier version, not re-verified" is the honest description — so it goes first in the human list.

**⚠️ Rows 8 and 9 — proven mechanism, unproven end-to-end.** Both fixes are genuinely red-checked at the unit level, and both have a gap between what the test drives and what a user experiences. Row 8's extraction is mocked, so "the import resumes" is proven while "the import completes against a real rate-limited provider" is not. Row 9's tests model ordering through an injected trigger; they cannot produce the slow disk that made the bug visible, so "a real cold start now shows a window" is inferred from the ordering rather than observed.

**⚠️ Rows 5, 12, 13 — real-world surfaces no test touches.** Audio hardware, pointer input, and a third-party API's current contents. Each is a place where the code is right and the world may not cooperate.

---

## What this audit changed

It was not a paperwork exercise — writing it surfaced two real gaps and closed both:

1. **`hasUsableCapacityForPurpose` had no test against real cooldown state.** Every proof that the purpose-aware deferral works injected a *fake* gate into `JobManager`. Those tests prove the scheduler consumes the answer correctly; not one proved the function producing that answer was right. Closed by `capacityForPurpose.test.ts`, whose central case demonstrates the two capacity questions genuinely **diverge on real state** — exhaust one purpose's chain and the whole-catalog question still answers "yes". That is the bug itself, reproduced against real machinery rather than a mock built to make it appear.

2. **Migration 003's backward-compatibility test had never been red-checked.** Now proven: a data-destroying migration makes it fail.

Both were rows that would have read "verified" in a table written from memory.
