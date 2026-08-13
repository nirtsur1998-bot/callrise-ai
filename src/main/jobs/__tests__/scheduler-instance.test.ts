// M26 Phase 5 — same shared-instance shape as jobs/instance.ts, tested the
// same way: a plain get/set contract, no Electron dependency here (the
// Scheduler itself needs app.getPath, but this module never constructs one).
import { describe, expect, it, afterEach } from 'vitest'
import { getScheduler, setScheduler, __resetSchedulerForTests } from '../scheduler-instance'
import type { Scheduler } from '../scheduler'

afterEach(() => {
  __resetSchedulerForTests()
})

describe('scheduler-instance', () => {
  it('throws if accessed before a Scheduler has been set', () => {
    expect(() => getScheduler()).toThrow(/accessed before it was initialized/)
  })

  it('returns exactly the instance that was set', () => {
    const fake = { registerRecurring: () => {} } as unknown as Scheduler
    setScheduler(fake)
    expect(getScheduler()).toBe(fake)
  })

  it('resetSchedulerForTests clears it back to the throwing state', () => {
    setScheduler({} as Scheduler)
    __resetSchedulerForTests()
    expect(() => getScheduler()).toThrow()
  })
})
