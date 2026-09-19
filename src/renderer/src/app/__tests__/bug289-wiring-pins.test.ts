// BUG-289 — pins confirming the fix is actually wired everywhere it needs to
// be, the way sidebarIntent.test.ts (BUG-286) pins its own threading:
// rendering CrmView/ContactsView/DealsView needs the whole contacts/deals/
// settings hook graph, so reading the real call sites proves more per line
// than a heavy render test would.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')
const code = (...p: string[]): string =>
  read(...p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('every one-shot-consume prop site goes through useConsumeId', () => {
  it('PastCallsView (M31 original) migrated to the shared hook, boolean latch gone', () => {
    const src = code('features', 'calls', 'PastCallsView.tsx')
    expect(src).toContain("useConsumeId(initialSelectedId")
    expect(src).not.toContain('consumedIdRef')
  })

  it('ContactsView and DealsView each use it for their own viewingId', () => {
    for (const [path, propName] of [
      [['features', 'contacts', 'ContactsView.tsx'], 'initialViewId'],
      [['features', 'deals', 'DealsView.tsx'], 'initialViewDealId']
    ] as const) {
      const src = code(...path)
      expect(src, path.join('/')).toContain(`useConsumeId(${propName}`)
      expect(src, `${path.join('/')} has no leftover boolean latch`).not.toMatch(
        /consumedRef\s*=\s*useRef\(false\)/
      )
    }
  })

  it('CrmView uses it TWICE — once per kind, so a contact click and a deal click never share one memory', () => {
    const src = code('app', 'CrmView.tsx')
    const dealCall = src.match(/useConsumeId\(initialDealId,[\s\S]*?\}\)/)?.[0] ?? ''
    const contactCall = src.match(/useConsumeId\(initialContactId,[\s\S]*?\}\)/)?.[0] ?? ''
    expect(dealCall, 'deal call sets the deal id AND the tab').toMatch(/setOpenDealId/)
    expect(dealCall).toMatch(/setTab\('deals'\)/)
    expect(contactCall, 'contact call sets the contact id AND the tab').toMatch(/setOpenContactId/)
    expect(contactCall).toMatch(/setTab\('contacts'\)/)
    expect(src).not.toContain('consumedDealIdRef')
    expect(src).not.toContain('consumedContactIdRef')
  })

  it('BUG-286s step-out reset is still wired through the hooks own reset(), not a bare ref', () => {
    const src = code('features', 'calls', 'PastCallsView.tsx')
    const stepOut = src.slice(src.indexOf('useStepOutToken('), src.indexOf('useStepOutToken(') + 200)
    expect(stepOut).toContain('resetConsumedId()')
  })
})

describe('CallsHub/PastCallsView needed no fix — verified, not assumed', () => {
  it('CallsHub forwards initialCallId straight through with no intermediate one-shot state', () => {
    const src = code('app', 'CallsHub.tsx')
    // The tab-forcing effect reacts to a CHANGED initialCallId on every
    // render, not just at mount — this is what CrmView's openDealId/
    // openContactId layer was missing before this fix.
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(initialCallId\) setTab\('past'\)/)
  })
})
