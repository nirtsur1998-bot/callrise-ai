// M34 3d — the live screen may show a deal's RECORDS, never anything derived
// from the outcome gate. The gate is closed and will stay closed for months;
// the HUD gets no exemption. This pins that structurally: no file under
// features/live may import the outcome-tracking modules, so the deal-facts
// line cannot later grow a win rate without this going red.
//
// Enumerates the CONTAINER (every source file under live/), not a list of
// the files someone remembered — a new file that imports the gate is caught
// the day it is written.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIVE = join(__dirname, '..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue
      out.push(...walk(p))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

// Every module that carries outcome-derived numbers or the insight itself.
const FORBIDDEN = [
  /deal-outcomes/,
  /OutcomeInsightCard/,
  /OutcomeBackfillDialog/,
  /dealBackfill\.insight/,
  /dealBackfill\.state/
]

describe('features/live imports nothing from the outcome gate', () => {
  const files = walk(LIVE)

  it('the walk found the live feature (control — the check below is not vacuous)', () => {
    expect(files.some((f) => f.endsWith('dealFacts.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('LiveView.tsx'))).toBe(true)
  })

  it('no live source file imports or calls the outcome-tracking modules', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const re of FORBIDDEN) {
        if (re.test(src)) offenders.push(`${f.slice(LIVE.length + 1)} matches ${re}`)
      }
    }
    expect(offenders, 'the live screen reached into the outcome gate').toEqual([])
  })

  it('the deal-facts module resolves risk through the calendar chip, not by reading the level itself', () => {
    const src = readFileSync(join(LIVE, 'dealFacts.ts'), 'utf8')
    expect(src).toMatch(/import \{ resolveRisk \} from '@renderer\/features\/calendar\/chipContext'/)
    expect(src).not.toMatch(/riskAssessment\??\.level/)
  })
})
