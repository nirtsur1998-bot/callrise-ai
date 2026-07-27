import { describe, expect, it } from 'vitest'
import { decideCaptureAction, type CapturePolicySettings } from '../policy'

const base: CapturePolicySettings = { autoCapturePolicy: 'mic-only', appOverrides: {} }

describe('decideCaptureAction', () => {
  it('ask policy always asks the user, regardless of consent', () => {
    const settings = { ...base, autoCapturePolicy: 'ask' as const }
    expect(decideCaptureAction('zoom', settings, { canRecordOtherParty: true })).toEqual({
      type: 'ask-user'
    })
    expect(decideCaptureAction('zoom', settings, { canRecordOtherParty: false })).toEqual({
      type: 'ask-user'
    })
  })

  it('mic-only policy starts mic-only regardless of consent (never unlocks buyer audio by itself)', () => {
    const settings = { ...base, autoCapturePolicy: 'mic-only' as const }
    expect(decideCaptureAction('zoom', settings, { canRecordOtherParty: true })).toEqual({
      type: 'start',
      mode: 'mic-only'
    })
    expect(decideCaptureAction('zoom', settings, { canRecordOtherParty: false })).toEqual({
      type: 'start',
      mode: 'mic-only'
    })
  })

  it('full policy starts full only when consent permits it', () => {
    const settings = { ...base, autoCapturePolicy: 'full' as const }
    expect(decideCaptureAction('zoom', settings, { canRecordOtherParty: true })).toEqual({
      type: 'start',
      mode: 'full'
    })
  })

  it('full policy silently degrades to mic-only when consent forbids it - the hard invariant', () => {
    const settings = { ...base, autoCapturePolicy: 'full' as const }
    expect(decideCaptureAction('zoom', settings, { canRecordOtherParty: false })).toEqual({
      type: 'start',
      mode: 'mic-only'
    })
  })

  it('a per-app "never" override ignores the call even under a full global policy with consent', () => {
    const settings: CapturePolicySettings = {
      autoCapturePolicy: 'full',
      appOverrides: { discord: 'never' }
    }
    expect(decideCaptureAction('discord', settings, { canRecordOtherParty: true })).toEqual({
      type: 'ignore'
    })
  })

  it('a per-app override beats the global policy in either direction', () => {
    const moreRestrictive: CapturePolicySettings = {
      autoCapturePolicy: 'full',
      appOverrides: { slack: 'ask' }
    }
    expect(decideCaptureAction('slack', moreRestrictive, { canRecordOtherParty: true })).toEqual({
      type: 'ask-user'
    })

    const lessRestrictive: CapturePolicySettings = {
      autoCapturePolicy: 'ask',
      appOverrides: { zoom: 'mic-only' }
    }
    expect(decideCaptureAction('zoom', lessRestrictive, { canRecordOtherParty: false })).toEqual({
      type: 'start',
      mode: 'mic-only'
    })
  })
})
