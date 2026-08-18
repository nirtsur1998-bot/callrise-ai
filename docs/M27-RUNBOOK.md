# M27 + Tier 1 → 1.3.0 — runbook

Paste-and-go. Written 2026-08-18 so nothing has to be reconstructed.

Read [`M27-tier1-recorder-handoff.md`](M27-tier1-recorder-handoff.md) first for
*why*; this file is only *what to run*.

**A rule that applies to every command below:** never append anything after the
command whose exit code you care about. No `| tail`, no `; echo "EXIT: $?"`, no
`> log 2>&1; echo`. Species 14 has recurred three times on this project, twice
in commands typed by the assistant that had just finished documenting it — once
making a **failed** build report exit 0. Redirect to a file, then read the file
as a separate step.

---

## 0. Start from a known-good point

```bash
cd "C:/Users/User/Desktop/callrise-m27" && git status --short && git log --oneline -4
```

Expect: no output from `status` (clean), and `HEAD` on
`claude/m27-field-hardening` at the docs/staging commit.

---

## 1. The recorder.ts checkpoint — its own commit, red-then-green

Edit **one** file's wiring: `src/renderer/src/features/live/audio/recorder.ts`.
Write its tests alongside. Then:

```bash
cd "C:/Users/User/Desktop/callrise-m27" && npx vitest run src/renderer/src/features/live/audio
```

### The red-check — mandatory, not optional

A green you have not watched go red is worth nothing. For **each** of the four
properties, break the code that implements it, confirm **that property's own
test** fails (and ideally only it), then restore.

Property 2 is the one to be most suspicious of. If reverting the wiring leaves
its test green, the test does not discriminate — **fix the test before shipping
the code.**

```bash
cd "C:/Users/User/Desktop/callrise-m27" && cp src/renderer/src/features/live/audio/recorder.ts /tmp/rec.bak
# ...break one thing on purpose, re-run the suite above, confirm the RIGHT test fails...
cd "C:/Users/User/Desktop/callrise-m27" && cp /tmp/rec.bak src/renderer/src/features/live/audio/recorder.ts
```

Commit on its own, not folded into the merge sweep:

```bash
cd "C:/Users/User/Desktop/callrise-m27" && git add -A src/renderer/src/features/live/audio && git commit
```

---

## 2. Merge to main at 1.3.0

```bash
cd "C:/Users/User/Desktop/callrise-m27" && git fetch origin && git checkout main && git pull --ff-only origin main
```

```bash
cd "C:/Users/User/Desktop/callrise-m27" && git merge --no-ff claude/m27-field-hardening
```

If `package.json` conflicts on version, resolve to **1.3.0**. Do **not**
`git add -A` while conflict markers may exist — that has staged markers on this
project before, caught only by typecheck.

```bash
cd "C:/Users/User/Desktop/callrise-m27" && node -e "console.log('version:', require('./package.json').version)"
```

---

## 3. Real typecheck and full suite on MERGED main

Exit codes read directly. Two separate steps each — run, then read.

```bash
cd "C:/Users/User/Desktop/callrise-m27" && npm run typecheck > /tmp/tc.log 2>&1
```
```bash
echo "TYPECHECK EXIT: $?"
```
> Read that `echo` in the **same shell call** as nothing else. If it is not `0`,
> stop — `cat /tmp/tc.log`.

```bash
cd "C:/Users/User/Desktop/callrise-m27" && npm test > /tmp/suite.log 2>&1
```
```bash
echo "SUITE EXIT: $?"
```

Expect ~2000 tests across ~201 files, plus the new Tier 1 ones
(30 in `src/main/__tests__/tier1.test.ts`, 17 in
`src/renderer/src/features/live/audio/__tests__/tier1-source.test.ts`).

---

## 4. Build + bundle-verify through the staleness gate

```bash
cd "C:/Users/User/Desktop/callrise-m27" && npm run build:win > /tmp/build.log 2>&1
```
```bash
echo "BUILD EXIT: $?"
```
> ~10–15 min. Run it in the background rather than blocking.

```bash
cd "C:/Users/User/Desktop/callrise-m27" && bash scripts/verify-bundle.sh
```
> Exit 3 = the staleness gate refused: source is newer than the artifact.
> That is the gate working. Rebuild; do not bypass it.

### Confirm the artifact contains what we think it contains

The denoiser — **by directory listing, not by build log.** This is the check
that caught the original packaging bug:

```powershell
Get-ChildItem "C:\Users\User\Desktop\callrise-m27\dist\win-unpacked\resources\virtualmic-win"
```

Expect exactly:
- `kern_bridge.exe` (~15.97 MB)
- `DeepFilterNet3_onnx.tar.gz` (~7.61 MB)

If `virtualmic-win` is absent, **stop** — that is 1.3.0 shipping a dead
feature, and it is the precise failure this release exists to fix.

Freshness against the exact commit:

```powershell
Get-Item "C:\Users\User\Desktop\callrise-m27\dist\CallRise AI Windows.exe" | Select-Object LastWriteTime
```
```bash
cd "C:/Users/User/Desktop/callrise-m27" && git log -1 --format="%H %cd"
```

---

## 5. Publish

Explicitly authorized by the founder for this release, repeatedly and after
concerns were raised. Do **not** hold for second-machine verification.

Release workflows are **tag-triggered** (`v*.*.*`) plus `workflow_dispatch`.
Neither fires on a PR or on a push to `main`, so tagging is the deliberate act
that ships.

```bash
cd "C:/Users/User/Desktop/callrise-m27" && git push origin main
```
```bash
cd "C:/Users/User/Desktop/callrise-m27" && git tag v1.3.0 && git push origin v1.3.0
```

Watch it:

```bash
gh run list --repo nirtsur1998-bot/callrise-ai --limit 3
```
```bash
gh run watch --repo nirtsur1998-bot/callrise-ai
```

---

## 6. Confirm it is actually live — all four, as with 1.2.6

```bash
gh release view v1.3.0 --repo nirtsur1998-bot/callrise-ai --json isDraft,tagName,assets
```

Expect `isDraft: false` (a draft is invisible to the auto-updater — v1.0.0
shipped as a silent draft once) and **4 assets**.

The one that proves clients will actually update:

```bash
curl -sL https://github.com/nirtsur1998-bot/callrise-ai/releases/latest/download/latest.yml
```

Expect `version: 1.3.0`. If it says anything else, the release exists but no
installed app will take it.

---

## 7. Release notes / STATUS.md — state plainly

**Verified:** engine proven on a clean-install artifact, on **one machine**;
renderer wiring tested at **unit/integration level only**.

**Not verified:** end-to-end on a **genuinely separate machine**; NSIS
install/uninstall behaviour; audio quality by ear; driver-absent call flow end
to end.

**For users, in plain language:** noise cancellation is **new for Windows**,
works with **no driver installed**, and the driver (which routes cleaned audio
into Zoom/Teams) is a **separate optional install** with its own requirements.

This is not hedging — it is what makes a field failure diagnosable in minutes
instead of guessed at blind.

---

## If something is wrong on the second machine

Ask for `%LOCALAPPDATA%\CallRiseAI\kern_bridge_status.json` first. It answers
the two questions that matter in one line:

- `modelLoaded: false` → **passthrough**; the model did not load. `modelPath`
  says exactly which file it looked for.
- **File absent** → the engine never started, or `%LOCALAPPDATA%` is not
  writable. Check `resources\virtualmic-win\` exists in the install.
