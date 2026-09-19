// BUG-287 — pins on the wiring itself, the way sidebarIntent.test.ts (BUG-286)
// pins its threading: `removeRecentlyViewed` is trivially easy to import and
// never call from any of the six real paths that delete or fail to find a
// call/contact/deal, and a render test of these screens (each pulling in
// useContacts/useDeals/useDealStages/useAppSettings/etc.) would prove far
// less per line than reading the actual call sites. Read from source, not
// re-implemented — `code()` strips comments so a doc explaining the old bug
// (which necessarily contains the old bare pattern in prose) can't fake a pin.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')
const code = (...p: string[]): string =>
  read(...p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('every explicit delete path prunes the trail (BUG-287 half 1)', () => {
  it('a call deleted via the grace-period path, via its unmount-flush path, and via the in-detail Delete button', () => {
    const useCalls = code('features', 'calls', 'useCalls.ts')
    // three real call-delete sites in this file: the grace-period timer, the
    // unmount cleanup that fires pending deletes early, must both prune.
    const matches = useCalls.match(/removeRecentlyViewed\('call', id\)/g) ?? []
    expect(matches.length, 'grace-period + unmount-flush deletes both prune').toBe(2)

    const callDetail = code('features', 'calls', 'CallDetail.tsx')
    expect(callDetail, 'the in-detail Delete button prunes too').toContain(
      "removeRecentlyViewed('call', callId)"
    )
  })

  it('a contact deleted through useContacts prunes on success, not on the blocked-by-open-deals case', () => {
    const src = code('features', 'contacts', 'useContacts.ts')
    const removeFn = src.slice(src.indexOf('const remove ='), src.indexOf('return {'))
    expect(removeFn).toContain("removeRecentlyViewed('contact', id)")
    // Must be gated on res.ok, not called unconditionally — a delete that was
    // blocked (contact still has open deals) must not prune a live record.
    const okBlock = removeFn.slice(removeFn.indexOf('if (res.ok)'), removeFn.indexOf('return res.ok'))
    expect(okBlock).toContain("removeRecentlyViewed('contact', id)")
  })

  it('a deal deleted via the grace-period path and via its unmount-flush path', () => {
    const useDeals = code('features', 'deals', 'useDeals.ts')
    const matches = useDeals.match(/removeRecentlyViewed\('deal', id\)/g) ?? []
    expect(matches.length).toBe(2)
  })
})

describe('a stale row says something instead of silently bouncing (BUG-287 half 2)', () => {
  it('CallDetail hands the caller a reason when the record is not found, and prunes right there', () => {
    const src = code('features', 'calls', 'CallDetail.tsx')
    expect(src, "the prop type carries a reason").toContain("onDeleted: (reason?: 'missing') => void")
    const missingBranch = src.slice(src.indexOf('if (c) setCall(c)'), src.indexOf('}, [callId])'))
    expect(missingBranch).toContain("removeRecentlyViewed('call', callId)")
    expect(missingBranch).toContain("onDeletedRef.current('missing')")
  })

  it('PastCallsView turns that reason into a message the rep actually reads', () => {
    const src = code('features', 'calls', 'PastCallsView.tsx')
    const onDeleted = src.slice(src.indexOf('onDeleted={'), src.indexOf('onChanged={refresh}'))
    expect(onDeleted).toContain("reason === 'missing'")
    expect(onDeleted).toMatch(/toast\.info\(.*deleted/i)
  })

  it('ContactsView and DealsView each detect a dead id against their OWN loaded list, only once loading has finished', () => {
    for (const [path, kind, listVar] of [
      [['features', 'contacts', 'ContactsView.tsx'], 'contact', 'contacts'],
      [['features', 'deals', 'DealsView.tsx'], 'deal', 'deals']
    ] as const) {
      const src = code(...path)
      // Must not fire before the list has loaded (an id that's valid but not
      // fetched yet must not be misdiagnosed as missing).
      expect(src, `${path.join('/')} gates on loading`).toMatch(/if \(loading \|\| !viewingId\) return/)
      expect(src, `${path.join('/')} checks its own list`).toContain(
        `${listVar}.some((`
      )
      expect(src).toContain(`removeRecentlyViewed('${kind}', viewingId)`)
      expect(src).toContain('setViewingId(null)')
    }
  })
})

describe('the command palette needed no separate fix', () => {
  it('it renders the SAME recently-viewed trail as the sidebar, so pruning at the source covers it', () => {
    const src = code('features', 'navigation', 'CommandPalette.tsx')
    expect(src).toContain('useRecentlyViewed()')
  })
})
