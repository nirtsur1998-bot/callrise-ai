# M40 — overnight handoff, 2026-09-18

Written while the founder slept, on the Mac, on branch `claude/m40-mac-parity` (both repos).
**Nothing pushed. Nothing published. Your working driver untouched** (`563ca8b1…`, verified).

Read top to bottom: what changed, what was proven, what needs you, what I did not do.

---

## The one-paragraph version

The Mac is closer than the audit made it sound. **The full test suite is green on macOS** — the
79 failures were a Node-version drift, not a platform defect, and are now guarded against
mechanically. The Mac package builds, the detection addon loads from `app.asar.unpacked` under
Electron's ABI, auto-update is fixed (zip target), check 6 and checks 1–5 have Mac paths, the floor
is 12.0 where we control it, the Intel refusal ships, and the uninstall button exists. What's left
splits cleanly: **certificates** (yours, in progress), **one build-infrastructure decision** (how CI
gets the denoiser — see §3), and **things only real hardware or a real login can close**.

---

## 1. Proven green — the test suite, on macOS

```
Node 22 (CI's version):  Test Files 468 passed | 3 skipped     Tests 4517 passed | 15 skipped   exit 0
Node 26 (this Mac's):    14 files / 79 tests failed — all but two on one cause
```

**Cause:** Node ≥ 25 ships its own `localStorage` global that shadows happy-dom's. Proven on one file:
Node 26 → 4 failed, Node 22 → 4 passed. `sessionStorage` untouched is the tell.

**Fixed mechanically** (`19827f8`): `.nvmrc` + `package.json#engines` = 22.x; a setup-file guard
that fails **once** with the exact remedy instead of 79 times. Red / green / quiet all verified.

**The escalation to the Windows session is answered:** verify-green is not red there if it runs
Node 22. Nothing suggests otherwise.

---

## 2. What shipped tonight (all on `claude/m40-mac-parity`, all unpushed)

| commit | what | verified how |
|---|---|---|
| `89f5f82` | check 6 reads `CFBundleShortVersionString` from the `.app` (`--app`, or auto-detect) | RED on a genuinely stale artifact ("4 min OLDER"), GREEN after rebuild — found its own test case |
| `9d3f0e0` | checks 1–5 point at `latest-mac.yml` with `--mac`; expected assets derived from the manifest; `TMP` no longer hardcoded to one Windows machine; check 3 counts instead of saying "four" | parses; derivation verified against the real manifest (`path:` → the ZIP). **Never run against a real feed** — no Mac release exists |
| `c910a89` | uninstall button (`uninstallDriver()`: stops helper, restarts coreaudiod, reads the result back) | typecheck, 50 tests, IPC exposed. **Control never seen rendered, never executed** — see §4 |
| `9222f67` | locality-claims gate: ACCOUNTED_FOR entry for the Intel-refusal copy | was FAIL on my sentence; 11/11 now. **Says it is not yet founder-approved — read it once** |
| `19827f8` | Node guard + pins (§1) | red/green/quiet |
| virtualmic `3fd08d0` | `build.sh` 11.0 → 12.0, both linked binaries now declare 12.0 | rtsafetytest PASS, underruntest 562/562, signature valid |

Plus earlier today: zip target (`8e760a0`), Intel refusal, tier1 gate, screen-sweep fix (call-detail
screens swept for the first time on any platform), `run.mjs`, tier1-diagnostics separators.

---

## 3. Needs YOU — one list

1. **Certificates** — Developer ID Application + Installer + `notarytool` credential (runbook in
   `M40-apple-certificates-runbook.md`). Reply "done".
2. **How CI gets the denoiser.** `verify-build-inputs.js` requires `michelper` and the `.driver`,
   both **gitignored, existing only on this Mac**. A macOS release job cannot pass until you pick:
   build from source in CI (recommended — makes it reproducible), publish virtualmic build output as
   release assets, or commit the binaries. All three need a **PAT** for the private sibling repo.
   The job was deliberately not written blind. Detail: `M40-stage3-mac-release-audit.md` §Blocker 3.
3. **Log into the sandbox once** so the authenticated screen tour can run. The README's two-file
   sign-in trick is **Windows-only** — on macOS `safeStorage` is Keychain-bound to the writing app's
   code signature, and the dev binary cannot decrypt the packaged app's session file (`DECRYPT
   FAILED`, measured). I will not enter credentials. Command to relaunch the sandbox is at the end.
4. **Read the ACCOUNTED_FOR entry** in `no-false-locality-claims.test.ts` for the Intel copy and
   either approve it or tell me to reword.
5. **Before the first signed release:** test on a machine with data under the *old* signature
   whether sessions and AI keys survive the signature change. `safeStorage` binds to the signature;
   what happens to existing users is **reasoned, not measured** (§ in the Stage 3 audit).
6. **Sidebar "Calls" no-op from an open call** — still yours/the Windows session's; test Home /
   Pipeline / Coaching from a detail page to settle severity (§1 in `M40-known-issues.md`).

---

## 4. What I did NOT do, and why

- **Did not click Remove.** It would uninstall your working driver. The path is verified to the
  IPC surface only.
- **Did not launch the packaged `.app`.** No sandbox mechanism exists for a packaged build on
  either platform (`CALLRISE_USER_DATA_DIR` is gated on `!app.isPackaged`; `HOME` override does not
  move `appData` on macOS — measured). Launching it drives your real 271 MB profile. The addon
  question was answered without it: `require()`d from the `.app` under Electron's ABI → **LOADED**.
- **Did not do the authenticated screen tour.** Blocked on §3.3. The two no-auth screens (login,
  sample call) are verified in **both themes** — background moved, hashes differ, driven via the
  stored preference not the class. Screenshots delivered.
- **Did not write the macOS release job.** Blocked on §3.2; writing it would embed a guess about
  a secret that does not exist.
- **Did not run on macOS 12.** The floor is declared and built against 12.0, never executed on it.
  Stays open until real hardware.
- **Did not push.** Both repos are on `claude/m40-mac-parity`, `main == origin/main` on both,
  verified on four conditions each.

---

## 5. Instruments that were wrong tonight, caught

- A probe reported `active-win — Module did not self-register`: the probe's fault; macOS active-win
  `execFile`s a helper and loads no `.node`.
- `console.log` inside a vitest test printed nothing — vitest swallows it; rewrote the probe to a
  file. A "0 lines" that was about forwarding, not the environment.
- A `7.2 % stale` reading from `underruntest`: my harness starting the reader before the writer.
  Primed first → 562/562.
- Three different sandbox-navigation probes measured the wrong page (Settings replaces the
  sidebar; a stale-coordinate re-entry; a predicate that looked for collapsed transcript text).

---

## To resume the sandbox tomorrow

```bash
cd /Users/nirtsur/callrise-ai
CALLRISE_USER_DATA_DIR=/private/tmp/claude-501/-Users-nirtsur-callrise-ai/adb440c9-f048-474a-8d09-6c00976cfdbe/scratchpad/sandbox2 \
  npx electron out/main/index.js --remote-debugging-port=9401
```

Log in once with the **test** account. Then say so, and the authenticated tour runs — every screen,
both themes, screenshots — plus the Remove control's rendering (still not clicked).
