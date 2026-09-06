// M35 — the tooltip primitive exists, is mounted once, and the sites the
// founder approved for it use it (2026-09-05: "one primitive, IconButton
// adoption, 14 hand edits; truncation reveals and short values stay native").
//
// Text pins, chosen before the render-test recipe was rediscovered (BUG-140 was stale).
// CORRECTION 2026-09-05: components CAN be render-tested here — see live-header-pieces.render.test.ts (`@vitest-environment happy-dom`, react-dom/client, a `.test.ts` file). The pure/UI split below still stands on its own merits; it is no longer forced.
// The classification itself is reproducible: scratchpad/tooltip-classify.mjs
// walked every `title=` back to its opening tag — 179 sites, 118 component
// props, 61 DOM attributes, of which 16 reveals, 13 labels, 6 + 8 explanatory.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

describe('the primitive', () => {
  it('wraps Radix, is themed with the app tokens, and is mounted ONCE at the app root', () => {
    const t = read('components/Tooltip.tsx')
    expect(t).toContain("from '@radix-ui/react-tooltip'")
    expect(t).toContain('bg-elevated')
    expect(t).toContain('text-ink')
    expect(t).toContain('export function TooltipProvider')
    const app = read('app/App.tsx')
    expect(app).toContain('<TooltipProvider>')
    expect((app.match(/<TooltipProvider>/g) ?? []).length).toBe(1)
    // nobody else mounts a second provider
    const others = walk(SRC).filter((f) => !f.endsWith('app\\App.tsx') && !f.endsWith('app/App.tsx') && !f.endsWith('Tooltip.tsx'))
    for (const f of others) expect(readFileSync(f, 'utf8'), f).not.toContain('<TooltipProvider>')
  })
})

describe('IconButton — one file, every icon-only control', () => {
  it('shows its label through the Tooltip and speaks it through aria-label; no native title', () => {
    const s = read('components/IconButton.tsx')
    expect(s).toContain('<Tooltip content={label}>')
    expect(s).toContain('aria-label={label}')
    expect(s).not.toMatch(/\btitle=/)
  })
})

describe('the 14 hand edits — the explanatory sentences a user reads', () => {
  const sites: [string, string][] = [
    ['components/SpeakerTranscript.tsx', 'We could not tell who was speaking here'],
    ['features/consent/OtherPartyControl.tsx', "Recording the other party isn't available on this platform"],
    ['features/consent/OtherPartyControl.tsx', 'Recording the other party is on (consent recorded)'],
    ['features/deal-intelligence/ui/NudgeCard.tsx', 'Thanks — this tunes future calls'],
    ['features/live/components/EngagementGauge.tsx', 'Engagement (approximate)'],
    ['features/live/components/MonologueMeter.tsx', "How long you've been talking"],
    ['features/settings/ApiKeysSection.tsx', "Opens the provider's own data-usage terms"],
    ['features/live/components/QuietToggle.tsx', 'Quiet is on — gauge, meter, suggestions'],
    ['features/deal-intelligence/ui/RadarReport.tsx', 'You marked this helpful'],
    ['features/live/components/MustAskStrip.tsx', '— covered`'],
    ['features/assistant/AssistantView.tsx', 'This conversation is only about'],
    ['features/assistant/AssistantView.tsx', 'is not learning from this conversation'],
    ['features/calendar/CalendarConnectBar.tsx', 'Dismiss — you can still connect from the header'],
    ['features/deals/OutcomeReasonPrompt.tsx', "Skip — don't record a reason"]
  ]
  for (const [rel, words] of sites) {
    it(`${rel}: "${words.slice(0, 40)}" is Tooltip content, not a title attribute`, () => {
      const s = read(rel)
      expect(s).toContain("import { Tooltip } from")
      expect(s).toContain(words)
      // the words must not sit in a title= attribute any more
      const idx = s.indexOf(words)
      const before = s.slice(Math.max(0, idx - 220), idx)
      expect(before, `${rel}: still a native title`).not.toMatch(/\btitle=\{?\s*$/)
      expect(before).toMatch(/content=|content\s*$|content=\{[\s\S]*$/)
    })
  }
})

describe('what stays native, on purpose', () => {
  it('a truncation reveal keeps its native title (the browser does this better)', () => {
    expect(read('features/contacts/ContactsView.tsx')).toMatch(/className="[^"]*truncate[^"]*"[^>]*title=\{contact\.name\}|title=\{contact\.name\}[^>]*className="[^"]*truncate/)
    expect(read('features/calls/PastCallsView.tsx')).toContain('title={call.title}')
  })
  it('a short dynamic value keeps its native title', () => {
    expect(read('features/contacts/ContactDetail.tsx')).toContain('title={countryName(contact.country)}')
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) {
      if (n !== '__tests__') out.push(...walk(p))
    } else if (/\.tsx$/.test(n)) out.push(p)
  }
  return out
}
