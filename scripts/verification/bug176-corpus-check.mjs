#!/usr/bin/env node
// BUG-176 — prove the in-call notice against EVERY real call, not a fixture.
//
// A unit test proves the rule does what I wrote. This proves what it would
// have DONE, on the founder's actual store: fires on the real failures, and
// stays silent on every healthy call. The false-positive rate that matters is
// the one measured against real data, not against cases I thought of.
//
// APPROXIMATION, stated because it changes what this proves: saved records
// carry no health payload, so `submittedSec` is approximated by durationMs and
// liveness is assumed 'ok'. That makes this check STRICTER than the shipped
// rule, which additionally refuses to fire when liveness is 'silent' — so a
// false positive here would also be one in the app, but not necessarily the
// reverse. Directionally safe: it cannot hide a false positive.
//
// PRIVACY: reads records, prints only counts, durations and dates.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'C:/Users/User/AppData/Roaming/sales-os/calls'
const WORDS_PER_MIN = 5
const MIN_SUBMITTED_SEC = 180

// BUG-179 — this file previously checked a SEGMENTS-per-minute rule and its
// failure is why the rule changed. Kept as a permanent guard: the check that
// found the defect is worth more than the fix it prompted.
const fires = (words, durMs) => {
  const submittedSec = durMs / 1000
  if (submittedSec < MIN_SUBMITTED_SEC) return false
  return words / (submittedSec / 60) < WORDS_PER_MIN
}

const rows = []
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue
  let c
  try { c = JSON.parse(readFileSync(join(DIR, f), 'utf8')) } catch { continue }
  if (!c?.segments) continue
  const sp = c.segments.filter((s) => s.kind !== 'gap')
  const durMs = c.durationMs ?? 0
  if (durMs <= 0) continue
  const words = sp.reduce((n, s) => n + String(s.text ?? '').trim().split(/\s+/).filter(Boolean).length, 0)
  rows.push({
    day: String(c.createdAt ?? '').slice(0, 10),
    mins: durMs / 60000,
    segs: sp.length,
    words,
    hasChannel: sp.some((s) => s.channel === 0 || s.channel === 1),
    fired: fires(words, durMs)
  })
}

// THE CONTROL. The harm to avoid is telling a rep a call "is not being
// captured" when it captured a real conversation. So: of every call the rule
// fires on, none may carry one.
//
// An absolute word floor was tried first and was the wrong control: it counted
// 114 words as "substantial" whether they covered three minutes or thirty. They
// covered 27 minutes, which is 4.2 words per minute — a broken call, not a
// captured conversation. So the bar is a RATE, set four times higher than the
// rule's own threshold: below 20 wpm, a call of several minutes has not
// captured a conversation on any reading, and above it the rule must stay
// silent. The margin between 5 and 20 is the thing being tested.
const long = rows.filter((r) => r.mins * 60 >= MIN_SUBMITTED_SEC)
const fired = long.filter((r) => r.fired)
const SUBSTANTIAL_WPM = 20
const falsePositives = fired.filter((r) => r.words / r.mins >= SUBSTANTIAL_WPM)

console.log(`
${rows.length} call records; ${long.length} long enough to be judged (>= ${MIN_SUBMITTED_SEC}s)
`)
console.log('CALLS THE NOTICE WOULD HAVE FIRED ON:')
for (const r of fired.sort((a, b) => (a.day < b.day ? -1 : 1)))
  console.log(`   ${r.day}  ${r.mins.toFixed(1).padStart(5)}m  ${String(r.words).padStart(4)} words  ${(r.words / r.mins).toFixed(1).padStart(5)} wpm  ${String(r.segs).padStart(3)} segs  channel=${r.hasChannel ? 'yes' : 'NO'}`)

console.log('')
console.log(`  calls judged                              : ${long.length}`)
console.log(`  the notice fires on                       : ${fired.length}`)
console.log(`  ...carrying a real conversation (>=${SUBSTANTIAL_WPM} wpm) : ${falsePositives.length}   <-- must be 0`)
for (const r of falsePositives)
  console.log(`      FALSE POSITIVE ${r.day} ${r.mins.toFixed(1)}m ${r.words} words ${r.segs} segs`)

// And the case that caught the first version, named explicitly.
const blob = long.find((r) => r.words > 800 && r.segs === 1)
if (blob)
  console.log(`  the 910-word single-segment mono call     : ${blob.fired ? '*** WARNED (regression)' : 'correctly silent'}`)
else console.log('  the 910-word single-segment mono call     : NOT FOUND in this store')

console.log('')
process.exit(falsePositives.length === 0 && blob && !blob.fired ? 0 : 1)
