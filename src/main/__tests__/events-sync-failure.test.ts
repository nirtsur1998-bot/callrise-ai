// BUG-169 — the words for a failed push, and the once-only Activity notice.
import { describe, expect, it } from 'vitest'
import {
  describeSyncFailure,
  noticeAlreadyShown,
  PUSH_FAILED_JOB_TYPE,
  shouldDrainOnReconcile,
  SYNC_FAILURE_TEXT
} from '../events-sync-failure'

describe('describeSyncFailure', () => {
  it('names the provider and says what a rep can act on, per code', () => {
    expect(describeSyncFailure('auth', 'google')).toBe('Not on Google Calendar: your sign-in to the calendar expired.')
    expect(describeSyncFailure('offline', 'outlook')).toBe('Not on Outlook: you were offline when it was saved.')
    expect(describeSyncFailure('forbidden')).toMatch(/^Not on your calendar: the calendar refused it/)
  })
  it('an http-NNN code is spelled out, an unknown code is shown as itself, no code is still a sentence', () => {
    expect(describeSyncFailure('http-502', 'google')).toBe('Not on Google Calendar: the calendar service answered with error 502.')
    expect(describeSyncFailure('weird', 'google')).toBe('Not on Google Calendar: weird.')
    expect(describeSyncFailure(undefined, 'google')).toBe('This event has not reached Google Calendar yet.')
  })
  it('every code the sync modules produce has words', () => {
    // From google-sync.ts / outlook-sync.ts classifyPushError and the pre-flight checks.
    for (const code of ['offline', 'auth', 'forbidden', 'not-found', 'server', 'not-enabled', 'not-connected']) {
      expect(SYNC_FAILURE_TEXT[code], code).toBeTruthy()
    }
  })
})

describe('noticeAlreadyShown — once per event', () => {
  const job = (state: string, eventId: string, type = PUSH_FAILED_JOB_TYPE): { type: string; state: string; input: unknown } => ({ type, state, input: { eventId } })
  it('a failed, queued or running notice for the same event blocks a second one', () => {
    for (const state of ['failed', 'queued', 'running']) {
      expect(noticeAlreadyShown([job(state, 'e1')], 'e1'), state).toBe(true)
    }
  })
  it('a notice that later succeeded (the event was pushed) does not block a NEW failure', () => {
    expect(noticeAlreadyShown([job('succeeded', 'e1')], 'e1')).toBe(false)
  })
  it('another event, or another job type, is not this event', () => {
    expect(noticeAlreadyShown([job('failed', 'e2')], 'e1')).toBe(false)
    expect(noticeAlreadyShown([job('failed', 'e1', 'calendar:reconcile')], 'e1')).toBe(false)
    expect(noticeAlreadyShown([], 'e1')).toBe(false)
  })
})

describe('shouldDrainOnReconcile — the post-pull drain never retries a failed push by itself', () => {
  it('drains only a pending delete', () => {
    expect(shouldDrainOnReconcile({ state: 'deleted' })).toBe(true)
    expect(shouldDrainOnReconcile({ state: 'deleted', lastError: 'offline' })).toBe(true)
  })

  it("leaves 'dirty' and 'error' to the user's Retry on the event — the founder's no-silent-auto-retry rule", () => {
    expect(shouldDrainOnReconcile({ state: 'dirty', lastError: 'offline' })).toBe(false)
    expect(shouldDrainOnReconcile({ state: 'dirty', lastError: 'auth' })).toBe(false)
    expect(shouldDrainOnReconcile({ state: 'error', lastError: 'not-found' })).toBe(false)
    expect(shouldDrainOnReconcile({ state: 'error', lastError: 'forbidden' })).toBe(false)
  })

  it('has nothing to do for synced, local-only or absent sync records', () => {
    expect(shouldDrainOnReconcile({ state: 'synced' })).toBe(false)
    expect(shouldDrainOnReconcile({ state: 'local-only' })).toBe(false)
    expect(shouldDrainOnReconcile(undefined)).toBe(false)
  })
})
