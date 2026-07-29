# Getting this branch onto your Mac and building it

`git push` from this environment is still blocked with a 403 (no repo write
access), so the only way to get this work onto your Mac is the bundle/patch
files delivered alongside this one. Everything below assumes you already have
a local clone of `callrise-ai` on your Mac (the one you run `npm run dev`
from).

## 1. Get the branch into your local clone

Open Terminal, `cd` into your project folder, then:

```bash
# Save M18-final.bundle wherever you downloaded it, then:
cd /path/to/callrise-ai
git fetch /path/to/M18-final.bundle claude/windows-voip-capture-health-ftjinc:claude/windows-voip-capture-health-ftjinc
git checkout claude/windows-voip-capture-health-ftjinc
```

If that branch name already exists locally and git complains, use a fresh
name instead:

```bash
git fetch /path/to/M18-final.bundle claude/windows-voip-capture-health-ftjinc:m18-work
git checkout m18-work
```

(The `.patch` file is a backup path only — if the bundle doesn't apply for
some reason, `git am M18-final.patch` from a clean `main` checkout replays
every commit one at a time instead.)

## 2. Install and verify

```bash
npm install
npm run typecheck   # should be clean
npm run lint        # should be clean
npm test            # 598 passing, 10 skipped
npm run build        # typechecks + builds the renderer/main JS — should be clean
```

If all four pass (they did here, repeatedly, in this environment), the code
itself is verified. What's left is packaging — the one thing this Linux
container genuinely cannot do for macOS.

## 3. Build the actual Mac app

```bash
npm run build:mac
```

This does three things: compiles the native ambient-detection addon for
macOS (`native/mac-audio-activity`), builds the renderer/main bundles, then
runs `electron-builder --mac` to produce a signed `.dmg` (unsigned/ad-hoc if
you don't have an Apple Developer identity configured — that's fine for your
own use, just not for redistributing to others).

**One pre-existing requirement, unrelated to anything in this branch:** the
noise-cancellation feature copies its already-built engine from a *sibling*
checkout, `../salesos-virtualmic` (a separate repo, next to this one on
disk). If you don't already have that checked out next to `callrise-ai/`,
`build:mac` will fail loudly at the packaging step looking for it — you've
presumably already built this successfully before (it shipped in an earlier
milestone), so it's likely already there. If it isn't, either check that repo
out at `../salesos-virtualmic` first, or ask me and I'll walk through
removing the `extraResources` block temporarily so you can build without it
(you'd just ship without noise cancellation on that build).

The built `.dmg` lands in `dist/`. That's what goes on the USB stick.

## What's actually been verified, and what hasn't

I could not launch a real macOS build in this container (no Mac, obviously),
so I can't personally confirm the `.dmg` opens and runs on your machine. What
I *did* verify from here, as a stand-in:

- Every automated check above (typecheck/lint/598 tests/build) passes.
- I built and ran the **Linux** equivalent of this same packaging pipeline
  end-to-end — same `electron-builder` config, same `afterPack` fuse-locking
  hook, same asar/native-module handling — and the packaged binary launched
  and ran stably for 15+ seconds with correct log output (including this
  branch's own `[updater] disabled: no update feed is configured` line,
  proving the actual compiled code path runs, not just typechecks). While
  doing that I found and fixed a real bug: the fuse-locking script guessed
  the Linux binary's name wrong and failed outright — now fixed, and this
  same script runs unchanged for all three platforms, so the fix reduces
  risk on the mac build too even though the specific bug only ever showed up
  on Linux.
- I could not test: real screen rendering (this container has no GPU/display
  a Mac would use), real sign-in (no live Supabase credentials here), or
  anything specific to macOS code-signing/notarization.

So: strong confidence the code is correct and the packaging pipeline works
in general; the Mac-specific finish line (does the signed .dmg actually open
and let you sign in and start a call) is the one thing only your machine can
confirm.
