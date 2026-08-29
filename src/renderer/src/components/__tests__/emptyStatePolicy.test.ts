import { describe, it, expect, vi } from 'vitest'
import {
  REASON_BADGE,
  resolveEmptyStateAction,
  type EmptyStateReason
} from '../emptyStatePolicy'
import type { SettingsPageId } from '@renderer/features/settings/settings-nav'

/**
 * M31 Stage 3 — the tri-state empty standard.
 *
 * Founder: *"'nothing here yet' vs 'this is switched off' vs 'this needs a
 * key' point at three different user actions, and right now they all look
 * identical. Getting that wrong is what made me think features were broken
 * when they were just off."*
 *
 * Two properties make that real, and both are asserted here: the states are
 * DISTINGUISHABLE without reading the prose, and each one's action actually
 * goes somewhere useful. Copy alone would not fix anything.
 */

const nav = (): ReturnType<typeof vi.fn<(page: SettingsPageId) => void>> =>
  vi.fn<(page: SettingsPageId) => void>()

describe('the states are distinguishable without reading the copy', () => {
  it('gives off / needsKey / broken their own badge, and empty none', () => {
    expect(REASON_BADGE.empty.icon).toBeNull()
    for (const kind of ['off', 'needsKey', 'broken'] as const) {
      expect(REASON_BADGE[kind].icon, `${kind} has no badge icon`).not.toBeNull()
      expect(REASON_BADGE[kind].label.length, `${kind} has no badge label`).toBeGreaterThan(0)
    }
  })

  it('never gives two states the same label or the same icon', () => {
    // The literal complaint was "they all look identical". Two states sharing
    // a badge would reproduce it while every other test still passed.
    const labelled = (['off', 'needsKey', 'broken'] as const).map((k) => REASON_BADGE[k])
    expect(new Set(labelled.map((b) => b.label)).size).toBe(3)
    expect(new Set(labelled.map((b) => b.icon)).size).toBe(3)
    expect(new Set(labelled.map((b) => b.tone)).size).toBe(3)
  })

  it('covers every reason kind — a new state cannot be silently unstyled', () => {
    const kinds: EmptyStateReason['kind'][] = ['empty', 'off', 'needsKey', 'broken']
    expect(Object.keys(REASON_BADGE).sort()).toEqual([...kinds].sort())
  })
})

describe('every off-state has somewhere to go (the dead-end fix)', () => {
  it('routes to the page the reason declares', () => {
    const go = nav()
    const action = resolveEmptyStateAction(
      { kind: 'off', settingsPage: 'sales-brain' },
      undefined,
      go
    )
    expect(action).not.toBeNull()
    action!.onClick()
    expect(go).toHaveBeenCalledWith('sales-brain')
  })

  it('produces a working action even when the caller supplied none', () => {
    // The structural guarantee: a call site that remembered to change the
    // WORDING but forgot the button still cannot make a dead end, because the
    // button comes from the reason rather than the caller.
    for (const page of ['objection-library', 'live-deal-intelligence', 'coach2'] as const) {
      const go = nav()
      resolveEmptyStateAction({ kind: 'off', settingsPage: page }, undefined, go)!.onClick()
      expect(go).toHaveBeenCalledWith(page)
    }
  })

  it('sends needs-a-key to the KEYS page, not to the feature toggle', () => {
    // Confusing these is the specific harm: landing on an on-switch that is
    // already on teaches the user the app is wrong about its own state.
    const go = nav()
    resolveEmptyStateAction({ kind: 'needsKey' }, undefined, go)!.onClick()
    expect(go).toHaveBeenCalledWith('ai-setup')
  })

  it('lets an explicit action win — some screens’ next step is not Settings', () => {
    const go = nav()
    const own = { label: 'Import your calls', onClick: vi.fn() }
    const action = resolveEmptyStateAction({ kind: 'off', settingsPage: 'sales-brain' }, own, go)
    expect(action).toBe(own)
    action!.onClick()
    expect(own.onClick).toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
  })
})

describe('states with nothing useful to press get no invented button', () => {
  it('adds no action to a plain empty state', () => {
    // 13 existing call sites pass no reason. Adding honesty must not silently
    // grow a button that navigates somewhere nobody asked for.
    expect(resolveEmptyStateAction({ kind: 'empty' }, undefined, nav())).toBeNull()
  })

  it('adds no action to a broken state — saying so plainly is the contribution', () => {
    expect(
      resolveEmptyStateAction({ kind: 'broken', detail: "The database didn't open." }, undefined, nav())
    ).toBeNull()
  })

  it('still honours an explicit action on empty/broken', () => {
    const own = { label: 'Retry', onClick: vi.fn() }
    expect(resolveEmptyStateAction({ kind: 'empty' }, own, nav())).toBe(own)
    expect(resolveEmptyStateAction({ kind: 'broken', detail: 'x' }, own, nav())).toBe(own)
  })
})
