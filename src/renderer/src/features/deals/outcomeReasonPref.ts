// M32 Stage 2 — how many times in a row the "why did this end that way?"
// prompt has been dismissed without an answer.
//
// ── WHY A STREAK AND NOT A DISMISS FLAG ──────────────────────────────────
//
// The founder's requirement was: *"if I skip it consistently, tell me rather
// than nagging."* Both halves matter, and the obvious implementations get one
// or the other wrong:
//
//   - A permanent "don't show again" checkbox puts the burden on the user to
//     notice the prompt is unwanted and go turn it off. Most people just keep
//     dismissing it forever. That is the nag.
//   - No memory at all is the same nag with extra steps.
//
// So the app watches its own reception. Three consecutive skips is the app
// concluding, from behaviour rather than from a setting, that this is not
// wanted — and saying so once, plainly, instead of asking a fourth time.
//
// ANSWERING RESETS THE STREAK TO ZERO. The signal is "consistently skipped",
// not "skipped three times ever": someone who answers most prompts and skips
// the occasional one they genuinely can't articulate should keep being asked.
//
// localStorage, matching this codebase's existing convention for per-machine
// UI dismissals (ActivationChecklist, AutoUpdateNoticeCard, connectBannerPref).
// It is a preference about how the app behaves, not user data — losing it on a
// reinstall costs one extra prompt.

const STREAK_KEY = 'deals.outcomeReason.skipStreak'
const TOLD_KEY = 'deals.outcomeReason.toldAboutStopping'

/** Consecutive skips after which the app stops asking and says so. */
export const SKIP_STREAK_LIMIT = 3

function readInt(key: string): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0 // storage unavailable — behave as if nothing was ever skipped
  }
}

export function skipStreak(): number {
  return readInt(STREAK_KEY)
}

/** True once the streak is at the limit — the app has stopped asking. */
export function promptRetired(): boolean {
  return skipStreak() >= SKIP_STREAK_LIMIT
}

/** True exactly once: the first render after retirement, so the app can say
 *  it has stopped rather than simply going silent. Going silent would leave
 *  the user unable to tell "it stopped asking" from "it broke". */
export function shouldAnnounceStopping(): boolean {
  try {
    if (!promptRetired()) return false
    if (localStorage.getItem(TOLD_KEY) === 'true') return false
    localStorage.setItem(TOLD_KEY, 'true')
    return true
  } catch {
    return false
  }
}

export function noteSkip(): void {
  try {
    localStorage.setItem(STREAK_KEY, String(skipStreak() + 1))
  } catch {
    /* storage unavailable — the prompt simply keeps appearing */
  }
}

export function noteAnswered(): void {
  try {
    localStorage.setItem(STREAK_KEY, '0')
    localStorage.removeItem(TOLD_KEY)
  } catch {
    /* as above */
  }
}

/** Test/reset seam — also what a future "ask me again" control would call. */
export function resetOutcomeReasonPrefs(): void {
  try {
    localStorage.removeItem(STREAK_KEY)
    localStorage.removeItem(TOLD_KEY)
  } catch {
    /* nothing to reset */
  }
}
