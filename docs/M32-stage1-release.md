# M32 Stage 1 — the release

**Prepared 2026-08-31. Version and rollout are the founder's call; nothing here has been
tagged, published, or pushed to a release feed.**

Branch `claude/m32-trust-evidence`, 13 commits ahead of `origin/main`.

---

## Version: **1.6.0**

A minor bump, not a patch. `1.5.3` would be wrong: this **changes what every API key card
says**, on every install, whether or not anything was broken for that user. A patch number
tells people nothing changed for them, and something did.

---

## Release notes

> ### Your API keys now tell you the truth
>
> **CallRise used to accept anything you pasted into a key field and tell you it was fine.**
> Type four random characters as your transcription key and the card would show a green
> tick, say "Configured", and confirm "takes effect immediately" — without ever having
> checked. You would find out on your next call.
>
> **Every key card now says what it actually knows**: checked, rejected, or not checked yet.
>
> - Saving a key **checks it with the provider** and shows you what they said. A rejected
>   key now reads **"Key invalid"** with the provider's own reason, instead of "Configured".
> - **Deepgram — the key live transcription runs on — could never be checked at all.** It
>   had no "Test key" button and nothing ever validated it. It now has both.
> - A saved key nobody has checked this session reads **"Not checked"** rather than
>   "Connected". This is the honest state, and it is the one most cards are in when you open
>   Settings. It is one click from an answer.
> - If a provider **rejects your key on more than one call**, CallRise stops leading with it
>   and says so on that card — including that **your default provider setting has not been
>   changed**, and how to undo it. Only the order it tries things in changes.
>
> **This is a behaviour change to every key card, not a bug fix**, which is why it is its
> own release.

---

## The five checks — to run AFTER publishing

From `docs/release-feed-verification.md`. **None of these can be run before the release
exists**; they verify the feed `electron-updater` actually reads. Listed here with the tag
filled in so they can be pasted.

```bash
gh release view v1.6.0 --json isDraft,isPrerelease,publishedAt
```
1. **Live, not a draft or prerelease.** Expect `isDraft: false`, `isPrerelease: false`, a
   real `publishedAt`.

```bash
git fetch origin --tags && git rev-parse v1.6.0^{commit} HEAD origin/main
```
2. **The tag names the commit that shipped.** All three hashes identical. If not, stop — do
   not retag; work out which commit was actually built.

```bash
gh release view v1.6.0 --json assets --jq '.assets[].name'
```
3. **All four assets attached.** Installer, portable, blockmap, `latest.yml`. Remember
   GitHub **hyphenates** asset names — take the name from `latest.yml`'s own `path:` field
   rather than hardcoding it. Hardcoding the spaced names is what made three of five checks
   fail on a perfectly good release once.

4. **`latest.yml` from the PUBLIC URL, hashed against the REAL installer.** Download the
   installer and hash it yourself; do not trust the manifest against itself.

5. **The staged rollout percentage is what you intended.** Default is 10%.

`node scripts/verification/five-checks.mjs` automates them.

---

## What is verified, and how

- **Full suite 304 files / 3063 tests, exit 0**; `npm run typecheck` exit 0. Read directly,
  nothing piped.
- **Driven live on the founder's own machine**, against their real keys, with a build from
  this worktree (identity pinned by page URL + process start time). Counted from the live
  DOM: `Connected` **0**, `Not checked` 5, `No key` 7, "Test key" buttons **12** (was 11).
- **Both new states demonstrated end to end**, not just unit-tested: `fakekey` saved to an
  empty Mistral card produced **"Key invalid — Your Mistral API key was rejected."**, and
  two real walks produced the demotion notice. The founder reproduced the OLD behaviour by
  hand on shipped v1.5.2 for the same input: "Configured · takes effect immediately."
- **Both themes**: light and dark, same label counts, contrast legible.
- **Scaling**: 900px wide and deviceScaleFactor 2 — no horizontal overflow in either.
- Every mutating drive ran under `state-guard.mjs`; the key vault was verified
  **byte-identical** to its pre-run snapshot afterwards.

## What is NOT verified

- **No packaged installer has been built or installed.** Everything above is
  `electron-vite build` + `electron out/main/index.js`, which is not the same artefact
  `electron-builder` produces. **A packaged-build pass is still owed before publishing** —
  species 45 (the build pipeline is a transformation between the fix and the artefact).
- The five feed checks, which need the release to exist first.
- No second machine, no clean install, no update-from-1.5.2 path.

## Also on this branch, and NOT part of Stage 1's story

Fixed but unrelated to the release notes above: BUG-149 (a live-purpose chain built in
Settings could never contain a non-Groq fallback) and its Model Assignment nudge. Worth a
line in the notes only if the founder wants it; it is invisible to anyone who never assigned
a model by hand.

Logged, not fixed: **BUG-150** (fire-and-forget memory extraction contaminating the suite),
**BUG-141** (unexplained, four hypotheses eliminated), and the `resolveCatalog` costing's
recommended 2-hour follow-up.
