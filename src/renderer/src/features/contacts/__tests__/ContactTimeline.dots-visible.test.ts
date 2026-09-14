// The contact timeline's coloured dots hang to the LEFT of the list (centred
// on its border line) with negative margins. The list lives inside the
// detail page's `overflow-y-auto` column, and an overflow-y of anything but
// visible makes overflow-x clip as well — so anything at a negative x is cut
// off. Found by the founder on 2026-09-14: every dot showed only its right
// half. The fix gives the list a left margin at least as wide as the overhang.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const timeline = readFileSync(join(__dirname, '..', 'ContactTimeline.tsx'), 'utf8')
const detail = readFileSync(join(__dirname, '..', 'ContactDetail.tsx'), 'utf8')

describe('contact timeline dots stay inside the scrolling column', () => {
  it('the column that holds the timeline clips on x (the reason the margin exists)', () => {
    expect(detail).toMatch(/overflow-y-auto[^>]*>[\s\S]*<ContactTimeline/)
  })

  it('the list reserves a left margin no smaller than the dots’ overhang', () => {
    const ul = timeline.match(/<ul className="([^"]+)"/)?.[1] ?? ''
    const dot = timeline.match(/-ml-\[(\d+)px\]/)?.[1]
    expect(ul.split(' ')).toContain('ml-2') // 8px
    expect(dot).toBeDefined()
    // Overhang = dot margin − (border 2px + padding 16px) = 24 − 18 = 6px < 8px margin.
    expect(Number(dot) - 18).toBeLessThanOrEqual(8)
    expect(Number(dot) - 18).toBeGreaterThan(0) // still hangs onto the line, not inside the text
  })
})
