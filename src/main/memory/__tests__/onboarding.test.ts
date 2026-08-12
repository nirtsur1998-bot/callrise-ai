import { describe, expect, it } from 'vitest'
import { ONBOARDING_TOPICS, topicById } from '../onboarding'

describe('ONBOARDING_TOPICS', () => {
  it('has 5 topics with unique ids', () => {
    expect(ONBOARDING_TOPICS).toHaveLength(5)
    const ids = ONBOARDING_TOPICS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every topic has a non-empty question and at least one allowed category', () => {
    for (const topic of ONBOARDING_TOPICS) {
      expect(topic.question.trim().length).toBeGreaterThan(0)
      expect(topic.categories.length).toBeGreaterThan(0)
    }
  })

  it('never includes a client-scoped category — onboarding is never about a specific call contact', () => {
    // client-fact is the only client-scope category in the whole allowlist
    // (types.ts's CATEGORY_SCOPE_KIND) — onboarding must never ask about a
    // specific contact, only the rep/business in general.
    for (const topic of ONBOARDING_TOPICS) {
      expect(topic.categories).not.toContain('client-fact')
    }
  })
})

describe('topicById', () => {
  it('finds a real topic by id', () => {
    expect(topicById('pricing')?.id).toBe('pricing')
  })

  it('returns undefined for an unknown id', () => {
    expect(topicById('not-a-real-topic')).toBeUndefined()
  })
})
