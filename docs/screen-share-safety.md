# Screen-share safety for the coaching overlay

## Why this gates everything else

The live-coaching overlay floats above every other window by design. That is
what makes it useful, and it is exactly what makes it leak.

The failure is not cosmetic. A battlecard reading _"they're evaluating
<Competitor> — lead with our migration story"_ rendered on the prospect's
screen during a share does not embarrass the rep, it ends the deal and
probably the account. Competitors market "invisible during screen shares" as a
headline feature, which tells you overlay leakage is a live,
complaint-generating problem in this category rather than a theoretical one.

**No live cue ships without this.** It is a prerequisite for every other
Phase 4 feature, not a hardening pass to do afterwards.

## What is implemented

`src/main/detection-overlay.ts` calls `win.setContentProtection(true)` on the
overlay window at creation.

One call covers both platforms. Electron maps it to:

| Platform              | Underlying mechanism                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| macOS                 | `NSWindowSharingNone` on the `NSWindow`                                  |
| Windows 10 2004+      | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`                       |
| Windows, older builds | `WDA_MONITOR` — the window is blanked in the capture rather than omitted |

The `WDA_MONITOR` fallback is worth knowing about: on a pre-2004 build the
sharer's audience sees a black rectangle where the overlay is, instead of the
overlay disappearing. Uglier, but still not a leak, which is the property that
matters.

### Deliberately not a setting

Applied unconditionally, with no toggle. A switch here is one mis-click away
from the exact failure it exists to prevent, and being able to show the overlay
inside a share is worth far less than never leaking one. If a demo genuinely
needs it visible, that is a code change and a conversation, not a preference.

### It does not affect our own capture

Buyer-side capture opens `getDisplayMedia` for its **audio** and stops the
video track immediately (`useTranscription.enableOtherParty`). Content
protection applies to the video path only, so nothing about buyer capture
changes.

## Verification matrix — NOT YET RUN

`setContentProtection` is a single API, but the conferencing apps each capture
differently — window capture, display capture, DXGI duplication, browser
`getDisplayMedia`, and on macOS ScreenCaptureKit vs the legacy path. A pass on
one proves very little about the others, so each cell needs its own check.

**Every cell below is unverified.** This cannot be tested from a Linux
container: it needs two machines (or a machine plus a phone) so the capture can
be observed from the _receiving_ side, which is the only side that proves
anything. A screenshot of the sharer's own screen shows nothing useful.

Method for each cell: start a share, have the overlay visible on the sharer's
screen, and screenshot **from the receiving participant's view**.

| App                  | Share mode           | macOS | Windows |
| -------------------- | -------------------- | ----- | ------- |
| Zoom                 | Entire screen        | ☐     | ☐       |
| Zoom                 | Window (CallRise AI) | ☐     | ☐       |
| Microsoft Teams      | Entire screen        | ☐     | ☐       |
| Microsoft Teams      | Window               | ☐     | ☐       |
| Google Meet (Chrome) | Entire screen        | ☐     | ☐       |
| Google Meet (Chrome) | Tab / window         | ☐     | ☐       |
| Google Meet (Edge)   | Entire screen        | ☐     | ☐       |
| Slack huddle         | Screen share         | ☐     | ☐       |

Also worth covering, because they use different capture paths again and are how
a leak would most likely be _discovered_ rather than prevented:

| Path                                            | macOS | Windows |
| ----------------------------------------------- | ----- | ------- |
| OS screenshot (`Cmd+Shift+4` / `Win+Shift+S`)   | ☐     | ☐       |
| OS screen recording (QuickTime / Xbox Game Bar) | ☐     | ☐       |

A cell fails if the overlay is legible in the received image. A blanked
rectangle on an older Windows build is a **pass** — see the `WDA_MONITOR` note
above.

## Known gaps

- **The main window is not content-protected**, and should not be — the rep
  routinely shares it deliberately, and the transcript is theirs to show. Only
  the always-on-top coaching overlay is excluded.
- If a future feature adds a second floating window (a battlecard rail, a
  monologue meter), it needs the same call. That is easy to forget, because the
  omission is invisible on the developer's own screen and only shows up on
  someone else's.
