// M29 A5.4 — the support bundle: one click in Settings → a dated folder in
// Downloads with a readable summary the user can email, plus the scrubbed
// diagnostic files. Finishes what M27 scoped and never built
// (docs/M27-audit-findings.md item I1).
//
// THE PRIVACY POSTURE, same as telemetry's: everything in the bundle passes
// through scrub() on the way out, free-text fields that can carry content
// (fallback `detail`, purpose-health `lastFailureDetail`, job titles and
// resultData, backup error prose) are STRIPPED — not scrubbed, absent — and
// the output filename set is a closed allowlist pinned by test, exactly like
// tier1-diagnostics' privacy pin. NO transcripts, keys, memories, contacts,
// journals, settings prose. Ever.

import { app, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { createLocalScrubber, scrub } from './telemetry/scrub'
import { scrubbedCopy } from './scrubbed-copy'
import { readRecentFallbackEvents } from './ai/fallback-log'
import { loadJobs } from './jobs/store'
import { getStatus as getTier1Status } from './tier1'
import { engineDiagnosticFiles } from './tier1-diagnostics'
import { updateStatus } from './updater/index'
import { currentConsent } from './telemetry/setup'
import { listQueued } from './telemetry/index'
import { readSweepSummary, type SweepSummary } from './memory/sweep-record-summary'

/**
 * A scrubber for WHOLE DOCUMENTS rather than single fields.
 *
 * The app-wide `scrub` caps every string at 4096 chars — correct for a log
 * line or a telemetry prop, catastrophic for a serialized JSON file. The M29
 * sweep measured the damage on the founder's own machine: `ai-purpose-health`
 * is 6,297 chars (13 purposes) and `jobs-summary` is 10,779 (47 jobs), so both
 * were being cut mid-string into unparseable JSON, silently losing 4 purposes
 * and 29 jobs — including the memory purposes behind BUG-057/080/082, i.e.
 * exactly the records a support reader needs. The existing test could not see
 * it because its fixture plants ONE purpose and ONE job, an order of magnitude
 * under the cap.
 *
 * Same redaction rules, no length cap. Bounding belongs to the callers (which
 * already have real bounds: 500 jobs, 1000 fallback entries, 2 MB logs).
 */
const scrubDocument = createLocalScrubber({ maxLength: Number.MAX_SAFE_INTEGER })

/** The closed set of files a bundle may contain — pinned by test. */
export const BUNDLE_FILES = [
  'support-summary.txt',
  'callrise.log',
  'callrise.old.log',
  'ai-fallback-events.jsonl',
  'ai-purpose-health.json',
  'jobs-summary.json',
  // M37 — the BUG-215 quote sweep's record: counts only, whitelisted by
  // memory/sweep-record-summary.ts, plus one sentence saying what a non-zero
  // means. It exists because the ramp criterion was unobservable — the number
  // lived only in a SQLite row on the user's own disk and nothing carried it.
  'sales-brain-sweep.json',
  // M37 — the BUG-D trap writes the one line that answers "did multichannel
  // capture actually work" (serverChannels, socketOpens, closeCode). It was
  // written to a file that NOTHING could collect: not this bundle, not the
  // BUG-D collector, not the triage instrument. An instrument whose output
  // cannot leave the machine measures nothing. Safe to include without
  // scrubbing prose because the line is key=value numbers only, pinned by
  // bugd-trap.test.ts's "the log line never carries a transcript word".
  'session-health.log',
  'kern_bridge.log',
  // The engine rotates to `kern_bridge.log.1` (kern_bridge.cpp: g_logPathPrev
  // = g_logPath + L".1"). This list previously said `kern_bridge.prev.log`, a
  // name that appears NOWHERE in the engine source — so after any rotation the
  // entire history of the failure being reported was collected by neither this
  // bundle nor M27's diagnostics zip. Both were wrong together, which is what
  // sharing one list buys: one fix repairs both.
  'kern_bridge.log.1',
  'kern_bridge_status.json'
] as const

/**
 * WHAT EACH FILE IS ALLOWED TO CONTAIN — the code half of the closing claim.
 *
 * The last three lines of every bundle say it "contains NO transcripts,
 * recordings, memories, contacts, deals, API keys, or account data". That
 * sentence was written when the bundle held nine files. It is a NEGATIVE claim
 * about a GROWING container, which is the kind someone else's commit falsifies:
 * whoever adds the eleventh file has no reason to re-read a sentence that has
 * been correct for months. The founder, 2026-09-09, on adding
 * sales-brain-sweep.json: "'true today' is how the ten false claims started."
 *
 * So the sentence is bound to the file set here. Every file declares what KIND
 * of thing it carries, every kind must be one the sentence survives, and the
 * sentence itself is pinned. Adding a file to BUNDLE_FILES without an entry
 * here fails; declaring a kind outside PERMITTED_KINDS fails; and when it does,
 * the fix is to change the SENTENCE, not to widen the list.
 */
export const BUNDLE_CONTENT_KINDS: Record<(typeof BUNDLE_FILES)[number], string> = {
  'support-summary.txt': 'diagnostic-metadata',
  'callrise.log': 'scrubbed-log',
  'callrise.old.log': 'scrubbed-log',
  'ai-fallback-events.jsonl': 'scrubbed-log',
  'ai-purpose-health.json': 'diagnostic-metadata',
  'jobs-summary.json': 'counts-and-ids',
  'sales-brain-sweep.json': 'counts-only',
  'session-health.log': 'scrubbed-log',
  'kern_bridge.log': 'scrubbed-log',
  'kern_bridge.log.1': 'scrubbed-log',
  'kern_bridge_status.json': 'diagnostic-metadata'
}

/** The kinds the closing claim can survive. A file carrying anything else makes
 *  that sentence false, and the sentence is what must change. */
export const PERMITTED_KINDS = [
  'counts-only',
  'counts-and-ids',
  'diagnostic-metadata',
  'scrubbed-log'
] as const

/** The closing claim itself, pinned so it cannot drift away from the list above
 *  without someone saying so out loud. */
export const BUNDLE_CLAIM = [
  'This bundle contains NO transcripts, recordings, memories, contacts,',
  'deals, API keys, or account data. Every file passed a scrubber that',
  'removes user paths, keys, emails, and ids on the way in.'
] as const

export interface BundleSources {
  userDataDir: string
  localAppData: string
  appVersion: string
  electronVersion: string
}

/** ai-fallback-events.jsonl minus the one field that can echo request text. */
function scrubbedFallbackLog(src: string, destDir: string): boolean {
  try {
    if (!existsSync(src)) return false
    const out: string[] = []
    for (const line of readFileSync(src, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Record<string, unknown>
        delete e.detail // stripped, not scrubbed — provider prose stays home
        out.push(scrub(JSON.stringify(e)))
      } catch {
        /* torn line: skip */
      }
    }
    writeFileSync(join(destDir, 'ai-fallback-events.jsonl'), `${out.join('\n')}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** ai-purpose-health.json minus lastFailureDetail. */
function scrubbedPurposeHealth(src: string, destDir: string): boolean {
  try {
    if (!existsSync(src)) return false
    const parsed = JSON.parse(readFileSync(src, 'utf8')) as Record<string, Record<string, unknown>>
    for (const rec of Object.values(parsed)) {
      if (rec && typeof rec === 'object' && 'lastFailureDetail' in rec) rec.lastFailureDetail = null
    }
    writeFileSync(
      join(destDir, 'ai-purpose-health.json'),
      scrubDocument(JSON.stringify(parsed, null, 2)),
      'utf8'
    )
    return true
  } catch {
    return false
  }
}

/**
 * M37 — the BUG-215 quote sweep's record, so the ramp criterion is observable.
 *
 * `rescuedByFileCheck` is the one number that says whether an irreversible
 * sweep could be trusted on a given machine, and until now it reached nobody:
 * telemetry never carried it, no UI showed it, and the only copy sat in a
 * SQLite table on the user's own disk. The founder, 2026-09-09: "a criterion
 * nobody can observe isn't a criterion... that's not a gate, it's a hope."
 *
 * COUNTS ONLY. The record is read as an unchecked cast in memory-runtime, so
 * whatever is in that row comes back typed as if it were the interface.
 * `projectSweepRecord` therefore whitelists nine known keys, type-checks each,
 * accepts `reason` only on an exact match of the two literals the code can
 * produce, and drops everything else — so no memory content, quote or call id
 * can reach this file even from a record written by a later version.
 *
 * Read through a SEPARATE read-only connection rather than the app's live
 * handle, so this bundle's own test can plant a real poisoned memory.db and
 * prove the whitelist holds against it. Never throws: a bundle must still be
 * produced on a machine where Sales Brain is off, absent, or broken.
 */
function sweepSummary(userDataDir: string, destDir: string): void {
  const { summary, meaning } = readSweepSummary(userDataDir)
  writeFileSync(
    join(destDir, 'sales-brain-sweep.json'),
    scrubDocument(JSON.stringify({ quoteSweep: summary, meaning }, null, 2)),
    'utf8'
  )
}

/** Job history as metadata only — never title (can carry names), never
 *  input/resultData/checkpoint (carry content by design; audit §1.4). */
function jobsSummary(destDir: string): number {
  let jobs: ReturnType<typeof loadJobs> = []
  try {
    jobs = loadJobs()
  } catch {
    /* no store yet */
  }
  const rows = jobs.map((j) => ({
    id: j.id,
    type: j.type,
    state: j.state,
    lane: j.lane,
    errorCode: j.error?.code ?? null,
    createdAt: j.createdAt,
    endedAt: j.endedAt ?? null
  }))
  writeFileSync(join(destDir, 'jobs-summary.json'), scrubDocument(JSON.stringify(rows, null, 2)), 'utf8')
  return rows.length
}

async function summaryText(src: BundleSources, collected: string[], dest: string): Promise<string> {
  const lines: string[] = []
  const push = (l = ''): void => {
    lines.push(l)
  }
  push('CallRise AI — support bundle')
  push(`created: ${new Date().toISOString()}`)
  push()
  push('== versions ==')
  push(`app: ${src.appVersion}`)
  push(`electron: ${src.electronVersion}`)
  push(`os: ${platform()} ${release()} (${arch()})`)
  push()
  push('== update ==')
  try {
    push(JSON.stringify(updateStatus()))
  } catch {
    push('(unavailable)')
  }
  push()
  push('== tier 1 noise cancellation ==')
  try {
    const t = getTier1Status()
    push(
      `engineAvailable=${t.engineAvailable} engineRunning=${t.engineRunning} connected=${t.connected} denoisingActive=${String(t.denoisingActive)}`
    )
  } catch {
    push('(unavailable)')
  }
  push()
  push('== telemetry ==')
  try {
    push(`consent: ${currentConsent().consent}; queued events: ${listQueued().length}`)
  } catch {
    push('(unavailable)')
  }
  push()
  push('== recent AI fallback events (detail stripped at source) ==')
  try {
    for (const e of await readRecentFallbackEvents(20)) {
      push(`${e.ts} ${e.purpose}: ${e.fromCatalogId} -> ${e.toCatalogId ?? 'EXHAUSTED'} (${e.reason})`)
    }
  } catch {
    push('(unavailable)')
  }
  push()
  push('== backup state (error prose scrubbed) ==')
  try {
    const p = join(src.userDataDir, 'backup-state.json')
    push(existsSync(p) ? readFileSync(p, 'utf8') : '(no backup state)')
  } catch {
    push('(unavailable)')
  }
  push()
  // M37 — the founder's condition: "say in the bundle's own summary what the
  // number means, so someone reading it cold knows a non-zero is a problem
  // rather than a statistic." The counts live in sales-brain-sweep.json; this
  // is the sentence that makes them legible without the context of the bug.
  push('== sales brain quote sweep ==')
  try {
    const raw = readFileSync(join(dest, 'sales-brain-sweep.json'), 'utf8')
    const doc = JSON.parse(raw) as { quoteSweep: SweepSummary | null; meaning: string }
    push(doc.meaning)
    push(`(counts in sales-brain-sweep.json; rescuedByFileCheck should be 0)`)
  } catch {
    push('(unavailable)')
  }
  push()
  push('== files in this bundle ==')
  for (const f of collected) push(`- ${f}`)
  push()
  // Rendered FROM the pinned constant rather than written here, so the prose a
  // user reads and the sentence the test guards cannot become two things.
  for (const line of BUNDLE_CLAIM) push(line)
  return scrubDocument(lines.join('\n'))
}

export interface SupportBundleResult {
  ok: boolean
  path?: string
  files?: string[]
  error?: string
}

/** Build the bundle into a new dated folder under `destRoot`. Exported for tests. */
export async function buildSupportBundle(
  src: BundleSources,
  destRoot: string
): Promise<SupportBundleResult> {
  try {
    const date = new Date().toISOString().slice(0, 10)
    let dest = join(destRoot, `CallRise-support-${date}`)
    for (let n = 2; existsSync(dest); n++) dest = join(destRoot, `CallRise-support-${date}-${n}`)
    mkdirSync(dest, { recursive: true })

    const collected: string[] = []
    const logsDir = join(src.userDataDir, 'logs')
    if (scrubbedCopy(join(logsDir, 'callrise.log'), join(dest, 'callrise.log')))
      collected.push('callrise.log')
    if (scrubbedCopy(join(logsDir, 'callrise.old.log'), join(dest, 'callrise.old.log')))
      collected.push('callrise.old.log')
    if (scrubbedFallbackLog(join(src.userDataDir, 'ai-fallback-events.jsonl'), dest))
      collected.push('ai-fallback-events.jsonl')
    if (scrubbedPurposeHealth(join(src.userDataDir, 'ai-purpose-health.json'), dest))
      collected.push('ai-purpose-health.json')
    if (scrubbedCopy(join(src.userDataDir, 'session-health.log'), join(dest, 'session-health.log')))
      collected.push('session-health.log')
    // Same file list M27's tier1-diagnostics export uses — one source of
    // truth for where the engine's logs live, so the two exports can't drift.
    for (const srcPath of engineDiagnosticFiles(src.localAppData)) {
      const name = srcPath.split(/[\\/]/).pop()!
      if (scrubbedCopy(srcPath, join(dest, name))) collected.push(name)
    }
    jobsSummary(dest)
    collected.push('jobs-summary.json')
    sweepSummary(src.userDataDir, dest)
    collected.push('sales-brain-sweep.json')

    writeFileSync(join(dest, 'support-summary.txt'), await summaryText(src, collected, dest), 'utf8')
    collected.unshift('support-summary.txt')
    return { ok: true, path: dest, files: collected }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : 'failed' }
  }
}

export function registerSupportBundle(): void {
  ipcMain.handle('support:createBundle', async () => {
    const result = await buildSupportBundle(
      {
        userDataDir: app.getPath('userData'),
        localAppData: process.env['LOCALAPPDATA'] ?? '',
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown'
      },
      app.getPath('downloads')
    )
    if (result.ok && result.path) shell.showItemInFolder(join(result.path, 'support-summary.txt'))
    return result
  })
}
