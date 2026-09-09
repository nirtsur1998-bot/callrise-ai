#!/usr/bin/env node
// PROTECTED INSTANCES — the one-writer rule as a mechanism, not a memory.
//
// WHY. "One writer on 9333, tell the founder before restarting anything" was
// a convention for three months and produced two violations, the second on
// 2026-09-06 at ~00:50: a session cleared its own sandbox Electron with
// `Get-Process electron | Where Path -like '*callrise-m34*' | Stop-Process`,
// which is also exactly what the founder's dev app is — same binary, same
// path — and the dev app died with it. The founder's ask: anything that
// kills processes checks what it is killing against the instances that are
// meant to survive.
//
// WHAT. classify(row) says, for a process row {pid, name, commandLine}, whether
// it is PROTECTED (the founder's dev app, the installed production app, or
// any CallRise instance not explicitly marked as a sandbox) or FAIR GAME (a
// sandbox instance: launched with CALLRISE_USER_DATA_DIR pointing at a
// sandbox profile, or the out-sandbox bundle, or a --remote-debugging-port
// other than 9333). stopMatching() refuses to stop a protected row unless
// the caller passes { allowProtected: 'I asked the founder' } — a string
// that has to be typed, so it cannot be passed by habit.
//
// USE IT INSTEAD of Stop-Process / taskkill for anything named electron,
// CallRiseAI or node:
//   node scripts/verification/protected-instances.mjs --list
//   node scripts/verification/protected-instances.mjs --stop-sandboxes
//   node scripts/verification/protected-instances.mjs --stop <pid>   # refused if protected
//
// The classification is pure and tested (src/__tests__/protected-instances.test.ts);
// the process listing and the kill are the only parts that touch the OS.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const DEV_DEBUG_PORT = 9333

/** @typedef {{ pid: number, name: string, commandLine: string }} ProcRow */

/**
 * @param {ProcRow} row
 * @returns {{ protectedBy: string | null, reason: string }}
 */
export function classify(row) {
  const name = (row.name ?? '').toLowerCase()
  const cmd = row.commandLine ?? ''
  const isElectron = name === 'electron.exe' || name === 'electron'
  const isInstalled = name === 'callriseai.exe' || /\\CallRiseAI\.exe/i.test(cmd)
  // the real command line is `...\electron-vite.js dev`, not `electron-vite dev`
  const isDevServer = name.startsWith('node') && /electron-vite(?:\.js)?["']?\s+dev\b/.test(cmd)
  if (isInstalled) return { protectedBy: 'installed app', reason: 'the production CallRise AI shares the profile; the founder may be in it' }
  if (isDevServer) return { protectedBy: 'dev server', reason: 'electron-vite dev — the writer on 9333' }
  if (isElectron) {
    const sandboxProfile = /CALLRISE_USER_DATA_DIR/.test(cmd) || /sandbox-profile/i.test(cmd)
    const sandboxBundle = /out-sandbox[\\/]main[\\/]index\.js/i.test(cmd)
    const port = /--remote-debugging-port=(\d+)/.exec(cmd)?.[1]
    const otherPort = port !== undefined && Number(port) !== DEV_DEBUG_PORT
    if (sandboxBundle || (sandboxProfile && otherPort)) return { protectedBy: null, reason: `sandbox instance (${sandboxBundle ? 'out-sandbox bundle' : 'sandbox profile'}${port ? `, port ${port}` : ''})` }
    if (port !== undefined && Number(port) === DEV_DEBUG_PORT) return { protectedBy: 'dev app', reason: 'the writer on 9333' }
    return { protectedBy: 'unmarked electron', reason: 'an Electron process with no sandbox marker — assumed to be the dev app or its children' }
  }
  return { protectedBy: null, reason: 'not a CallRise process' }
}

/** @returns {ProcRow[]} */
export function listProcesses() {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(electron|CallRiseAI|node)(\\.exe)?$' } | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; name = $_.Name; commandLine = [string]$_.CommandLine } } | ConvertTo-Json -Compress`
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()
  if (!out) return []
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * Stop the rows the predicate selects — refusing every protected one unless
 * allowProtected is the exact phrase.
 * @param {ProcRow[]} rows
 * @param {(row: ProcRow) => boolean} predicate
 * @param {{ allowProtected?: string, kill?: (pid: number) => void, isRunning?: (pid: number) => boolean }} [opts]
 * @returns {{ stopped: object[], refused: object[], failed: object[] }}
 */
export function stopMatching(rows, predicate, opts = {}) {
  const kill = opts.kill ?? ((pid) => execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }))
  const alive = opts.isRunning ?? isRunning
  const stopped = []
  const refused = []
  const failed = []
  for (const row of rows) {
    if (!predicate(row)) continue
    const c = classify(row)
    if (c.protectedBy && opts.allowProtected !== 'I asked the founder') {
      refused.push({ pid: row.pid, name: row.name, protectedBy: c.protectedBy, reason: c.reason })
      continue
    }
    // ONE FAILED KILL MUST NOT ABORT THE SWEEP. Twice on 2026-09-09 this threw
    // and stopped mid-loop: listProcesses snapshots parents AND their children,
    // killing a parent takes its children with it, and taskkill then exits
    // non-zero on a pid that no longer exists. The output was a raw node stack
    // trace, which reads like nothing was stopped — while in fact the first
    // process died and every LATER sandbox stayed alive. A stray sandbox
    // Electron still holding memory.db open is exactly what corrupts the next
    // drive, so a half-finished sweep is worse than a loud one.
    //
    // The failure is not swallowed, it is RE-CHECKED. Gone -> it is stopped,
    // which is what the caller asked for. Still running -> recorded in `failed`
    // and reported, because "already dead" and "access denied" must not look
    // the same.
    try {
      kill(row.pid)
      stopped.push({ pid: row.pid, name: row.name, reason: c.reason })
    } catch (err) {
      if (!alive(row.pid)) {
        stopped.push({ pid: row.pid, name: row.name, reason: c.reason + ' (already gone — died with its parent)' })
      } else {
        failed.push({ pid: row.pid, name: row.name, error: err.message })
      }
    }
  }
  return { stopped, refused, failed }
}

/** Is this pid still alive? Only ever used to tell "already dead" from "could
 *  not kill it". Returns TRUE when it cannot tell — never claim a process is
 *  gone on the strength of a failed query. */
function isRunning(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' })
    return out.includes(String(pid))
  } catch {
    return true
  }
}

export function main(argv) {
  const rows = listProcesses()
  if (argv.includes('--list') || argv.length === 0) {
    for (const r of rows) {
      const c = classify(r)
      console.log(`${String(r.pid).padStart(6)}  ${r.name.padEnd(14)}  ${c.protectedBy ? 'PROTECTED (' + c.protectedBy + ')' : 'fair game'}  — ${c.reason}`)
    }
    return 0
  }
  if (argv.includes('--stop-sandboxes')) {
    const res = stopMatching(rows, (r) => classify(r).protectedBy === null && (r.name.toLowerCase().startsWith('electron')))
    for (const s of res.stopped) console.log(`stopped ${s.pid} ${s.name} — ${s.reason}`)
    for (const s of res.refused) console.log(`REFUSED ${s.pid} ${s.name} — ${s.protectedBy}: ${s.reason}`)
    for (const s of res.failed) console.log(`*** COULD NOT STOP ${s.pid} ${s.name} — still running: ${s.error}`)
    return res.failed.length ? 3 : 0
  }
  const at = argv.indexOf('--stop')
  if (at >= 0) {
    const pid = Number(argv[at + 1])
    const allow = argv.includes('--i-asked-the-founder') ? 'I asked the founder' : undefined
    const res = stopMatching(rows, (r) => r.pid === pid, { allowProtected: allow })
    for (const s of res.stopped) console.log(`stopped ${s.pid} ${s.name} — ${s.reason}`)
    for (const s of res.refused) console.log(`REFUSED ${s.pid} ${s.name} — ${s.protectedBy}: ${s.reason}. Ask the founder, then pass --i-asked-the-founder.`)
    for (const s of res.failed) console.log(`*** COULD NOT STOP ${s.pid} ${s.name} — still running: ${s.error}`)
    return res.refused.length ? 2 : res.failed.length ? 3 : 0
  }
  console.log('usage: --list | --stop-sandboxes | --stop <pid> [--i-asked-the-founder]')
  return 1
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
