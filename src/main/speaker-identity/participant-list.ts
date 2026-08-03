// Meeting-app participant list (M19 Task 2, Part B step 4) — NOT IMPLEMENTED.
//
// The brief: "Zoom / Meet / Teams participant list — macOS Accessibility API
// against the meeting window, Windows UI Automation, browser tab title for
// web meetings. This is fiddly and breaks on app updates — best-effort only."
//
// Dedicated research (before writing any of this milestone's code) confirmed
// there is NO existing accessibility-tree or UI-automation capability
// anywhere in this repo — not in native/mac-audio-activity (which exposes
// only process enumeration, audio-session activity, and raw window TITLES
// via CGWindowListCopyWindowInfo — no AXUIElement tree-walking), not in
// native/win-audio-sessions (EnumWindows + GetWindowTextW — no IUIAutomation),
// and active-win (the npm package this repo already uses in active-app.ts)
// is deliberately called with screenRecordingPermission: false, which forces
// its `title` field empty even though the underlying package supports more.
//
// Genuine per-app participant-list extraction is real new native work on
// BOTH platforms — macOS AXUIElement tree-walking to find a participant
// roster view inside Zoom/Meet/Teams' actual window hierarchy, or Windows
// IUIAutomation doing the equivalent — not a config change or a wiring task.
// Writing that blind, without real hardware and a real meeting app window to
// verify against, is exactly the mistake this repo's own M18 already made
// once (the EFX registration attempt documented in CLAUDE.md's "Current
// blocker" section broke COM registration for every virtual endpoint) and
// deliberately avoided a second time in windows-capture.md's per-process-
// loopback addon ("not written blind... cannot be compiled, tested, or reach
// Windows CI... shipping hundreds of lines of unbuildable COM code would
// only be honestly describable as unverified").
//
// So: this step is stubbed, not faked. The one thing that DOES already exist
// — window TITLE strings — is exposed here in case a future pass wants to
// regex-extract a name from patterns like "Meeting with Jane Doe - Zoom"
// (small, no new native code); that is a materially different, much smaller
// task than a real participant roster and is left undone rather than
// half-built and presented as the real thing.

/**
 * The cascade's step 4 hook. Always returns null — see the file header. A
 * real implementation would take the active meeting-app window (found via
 * the existing detection/appRegistry.ts matching) and return every
 * participant name visible in its roster UI.
 */
export async function resolveFromParticipantList(
  meetingAppWindowTitle: string
): Promise<{ names: string[] } | null> {
  // Deliberately unused — no accessibility-tree capability exists to read a
  // participant roster from yet. Kept as a real parameter (not dropped) so
  // the signature a real implementation needs is already agreed.
  void meetingAppWindowTitle
  return null
}
