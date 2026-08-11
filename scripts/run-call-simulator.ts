/**
 * Manual-run CLI for the Call Simulator (M24 — testing requirements).
 *
 * Plays a canned transcript through the Live Call State engine at real (or
 * sped-up) wall-clock pace, printing each turn and every Tier 0 signal as it
 * fires, then a plain-language summary of the final state. This is what a
 * non-technical founder runs from a terminal to manually verify the
 * milestone end-to-end without needing a real call, ASR, or the Electron
 * app running at all — see run-call-simulator's sibling detect:debug script
 * for the same "headless, console-only" pattern applied to a different
 * feature.
 *
 * Run with: npm run simulate:call -- [healthy|stalling|authority] [speed]
 *   e.g.    npm run simulate:call -- stalling 5
 *
 * Deliberately plain Node/relative imports, no '@renderer/...' alias: tsx
 * runs this standalone from the repo root with no vite involved, so the
 * alias would not resolve.
 */
import { runSimulation } from '../src/renderer/src/features/deal-intelligence/simulator/callSimulator'
import { TRANSCRIPT as HEALTHY_TRANSCRIPT } from '../src/renderer/src/features/deal-intelligence/simulator/transcripts/healthy'
import { TRANSCRIPT as STALLING_TRANSCRIPT } from '../src/renderer/src/features/deal-intelligence/simulator/transcripts/stalling'
import { TRANSCRIPT as AUTHORITY_TRANSCRIPT } from '../src/renderer/src/features/deal-intelligence/simulator/transcripts/authorityHeavy'
import type {
  LiveCallState,
  LiveTurn,
  SpeakerRole,
  Tier0Signal
} from '../src/renderer/src/features/deal-intelligence/types'

interface TranscriptOption {
  label: string
  turns: LiveTurn[]
}

const TRANSCRIPTS: Record<string, TranscriptOption> = {
  healthy: { label: 'Healthy call', turns: HEALTHY_TRANSCRIPT },
  stalling: { label: 'Stalling call', turns: STALLING_TRANSCRIPT },
  authority: { label: 'Authority/procurement-heavy call', turns: AUTHORITY_TRANSCRIPT }
}

const ROLE_LABEL: Record<SpeakerRole, string> = {
  rep: 'REP  ',
  other: 'BUYER',
  unknown: '?????'
}

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function formatElapsed(atMs: number, callStartedAtMs: number): string {
  const seconds = Math.max(0, (atMs - callStartedAtMs) / 1000)
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function parseArgs(argv: string[]): { transcriptKey: string; speedMultiplier: number } {
  const [transcriptArg, speedArg] = argv
  const transcriptKey = transcriptArg ?? 'healthy'
  const speedMultiplier = speedArg === undefined ? 1 : Number(speedArg)

  if (!(transcriptKey in TRANSCRIPTS)) {
    console.error(
      `Unknown transcript "${transcriptKey}". Choose one of: ${Object.keys(TRANSCRIPTS).join(', ')}`
    )
    process.exit(1)
  }
  if (!Number.isFinite(speedMultiplier) || speedMultiplier <= 0) {
    console.error(`Speed multiplier must be a positive number, got "${speedArg}".`)
    process.exit(1)
  }

  return { transcriptKey, speedMultiplier }
}

function printSummary(state: LiveCallState): void {
  console.log('\n--- Final call state ---')
  console.log(
    `Talk ratio (rep share):   ${state.talkRatio === null ? 'not enough talk yet' : `${Math.round(state.talkRatio * 100)}%`}`
  )
  console.log(`Longest rep monologue:    ${Math.round(state.longestRepMonologueMs / 1000)}s`)
  console.log(`Buyer questions asked:     ${state.buyerQuestionCount}`)
  console.log(
    `Objections raised:         ${
      state.objections.length === 0
        ? 'none'
        : state.objections.map((o) => `${o.type} (${o.status})`).join(', ')
    }`
  )
  console.log(
    `Budget mentions:           ${state.budgetMentions.reduce((n, m) => n + m.evidence.length, 0)}`
  )
  console.log(
    `Timeline mentions:         ${state.timelineMentions.reduce((n, m) => n + m.evidence.length, 0)}`
  )
  console.log(`Sentiment samples logged:  ${state.sentimentTrajectory.length}`)
  console.log(`Final call stage:          ${state.callStage}`)
  console.log('-------------------------\n')
}

async function main(): Promise<void> {
  const { transcriptKey, speedMultiplier } = parseArgs(process.argv.slice(2))
  const { label, turns } = TRANSCRIPTS[transcriptKey]
  const callStartedAtMs = turns[0]?.atMs ?? 0

  console.log(`--- Call Simulator: ${label} (${speedMultiplier}x speed) ---`)
  console.log(`${turns.length} turns queued. Playing in real time — watch it unfold.\n`)

  const { state } = await runSimulation(turns, {
    speedMultiplier,
    onTurn: (turn) => {
      const elapsed = formatElapsed(turn.atMs, callStartedAtMs)
      console.log(`[${elapsed}] ${ROLE_LABEL[turn.role]} ${truncate(turn.text)}`)
    },
    onSignal: (signal: Tier0Signal) => {
      console.log(`         >>> SIGNAL [${signal.type}] ${signal.detail}`)
    }
  })

  printSummary(state)
}

main().catch((err: unknown) => {
  console.error('Call Simulator crashed:', err)
  process.exit(1)
})
