// BUG-186 — a dev build pointed at a COPY of the profile must not reach the
// real cloud backup.
//
// What happened (2026-09-04): a copy of the founder's profile, launched from a
// worktree under CALLRISE_USER_DATA_DIR to screenshot a fix, pushed to the
// founder's real cloud backup within a minute of starting — it carried
// `supabase-auth.json`, so it WAS the account, and nothing in the app knew it
// was a sandbox. Founder: "a test copy reaching my real backend is one step
// from a test copy overwriting it." Taxonomy species 76: the isolation of a
// sandbox is decided by what it can REACH, not by where its files live.
//
// The rule: when the profile is overridden, backup.ts refuses push AND pull
// unless CALLRISE_SANDBOX_ALLOW_SYNC=1 is ALSO set. Auth still works, so a
// copy can stay signed in; the backend is simply unreachable from it.
//
// index.ts is the ONLY reader of CALLRISE_USER_DATA_DIR (pinned by
// dev-profile-override.test.ts: one read, gated on app.isPackaged) — so it
// tells this module rather than this module reading the variable again. A
// packaged build never calls markSandboxProfile with a directory, so the
// refusal cannot fire on a real user's machine.

let sandboxDir: string | null = null
let allowSync = false

/** Called once from index.ts with the resolved override (or undefined). */
export function markSandboxProfile(overrideDir: string | undefined, allowSyncFlag: boolean): void {
  sandboxDir = overrideDir || null
  allowSync = allowSyncFlag
}

/** Pure: does this configuration refuse the cloud backup? */
export function sandboxRefusesSync(overrideDir: string | null | undefined, allowSyncFlag: boolean): boolean {
  return Boolean(overrideDir) && !allowSyncFlag
}

export function isSandboxProfile(): boolean {
  return sandboxDir !== null
}

/** The launch line — one, so a log can be searched for it. */
export function describeSandboxProfile(): string | null {
  if (!sandboxDir) return null
  return sandboxRefusesSync(sandboxDir, allowSync)
    ? `[dev] SANDBOX profile at ${sandboxDir}: cloud backup push and pull REFUSED (set CALLRISE_SANDBOX_ALLOW_SYNC=1 to allow)`
    : `[dev] SANDBOX profile at ${sandboxDir}: cloud backup ALLOWED by CALLRISE_SANDBOX_ALLOW_SYNC=1 — this copy WILL reach the real backend`
}

/** backup.ts's gate. Never throws. */
export function backupRefusedForSandbox(): boolean {
  return sandboxRefusesSync(sandboxDir, allowSync)
}

/** Tests only. */
export function resetSandboxProfileForTests(): void {
  sandboxDir = null
  allowSync = false
}
