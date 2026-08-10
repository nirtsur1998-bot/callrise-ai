import { describe, expect, it } from 'vitest'
import { toGeminiSchema } from '../gemini'

// Root-caused 2026-08-03: a real user's "summary" job failed on every single
// attempt (chain exhausted, generic 'failed' code) because Gemini's function-
// calling Schema only supports a subset of OpenAPI's Schema object -
// `additionalProperties` isn't in it, and every AITool in this codebase sets
// `additionalProperties: false` (plain JSON Schema convention, which
// Anthropic/OpenAI both accept natively). Gemini rejected the whole request
// with a 400 the moment it saw the unrecognized field.
describe('toGeminiSchema', () => {
  it('strips additionalProperties at the top level', () => {
    const out = toGeminiSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    })
    expect(out).not.toHaveProperty('additionalProperties')
    expect(out.type).toBe('object')
    expect(out.required).toEqual(['name'])
  })

  it('strips additionalProperties from nested object properties', () => {
    const out = toGeminiSchema({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: { city: { type: 'string' } },
          additionalProperties: false
        }
      },
      additionalProperties: false
    })
    const address = (out.properties as Record<string, unknown>).address as Record<string, unknown>
    expect(address).not.toHaveProperty('additionalProperties')
    expect(address.type).toBe('object')
  })

  it('strips additionalProperties from array item schemas', () => {
    const out = toGeminiSchema({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }
    })
    expect(out.items).not.toHaveProperty('additionalProperties')
  })

  it('strips $schema', () => {
    const out = toGeminiSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' })
    expect(out).not.toHaveProperty('$schema')
  })

  it('preserves every field Gemini does support', () => {
    const input = {
      type: 'object',
      description: 'A thing',
      properties: { n: { type: 'number', description: 'count' } },
      required: ['n'],
      enum: ['a', 'b']
    }
    expect(toGeminiSchema(input)).toEqual(input)
  })

  // M22 bug hunt: live-cue.ts's buyerName/buyerSpeaker fields use JSON Schema
  // 2020-12's `type: ['string', 'null']` nullable convention. Gemini's Schema
  // object doesn't support `type` as an array at all — only a single type
  // value plus a separate `nullable: true` (OpenAPI 3.0's convention) — so
  // this shape 400'd every live-cue request to Gemini, unreachable via the
  // default chains but real the moment a user assigns Gemini as a coaching-
  // cue model in Settings.
  describe('nullable type arrays (JSON Schema 2020-12 -> OpenAPI 3.0)', () => {
    it('converts type: [X, "null"] to type: X, nullable: true', () => {
      const out = toGeminiSchema({ type: ['string', 'null'], description: 'buyer name' })
      expect(out.type).toBe('string')
      expect(out.nullable).toBe(true)
    })

    it('works regardless of which position "null" is in', () => {
      const out = toGeminiSchema({ type: ['null', 'integer'] })
      expect(out.type).toBe('integer')
      expect(out.nullable).toBe(true)
    })

    it('does not mark nullable when there is no "null" in the array', () => {
      // Not a real case emitted by this codebase's tools, but the function
      // should not fabricate nullability that was never asked for.
      const out = toGeminiSchema({ type: ['string'] })
      expect(out.type).toBe('string')
      expect(out).not.toHaveProperty('nullable')
    })

    it('recurses into nested properties carrying a nullable type array', () => {
      const out = toGeminiSchema({
        type: 'object',
        properties: {
          buyerName: { type: ['string', 'null'] },
          buyerSpeaker: { type: ['integer', 'null'] }
        }
      })
      const props = out.properties as Record<string, Record<string, unknown>>
      expect(props.buyerName.type).toBe('string')
      expect(props.buyerName.nullable).toBe(true)
      expect(props.buyerSpeaker.type).toBe('integer')
      expect(props.buyerSpeaker.nullable).toBe(true)
    })

    it('leaves an ordinary (non-array) type completely untouched', () => {
      const out = toGeminiSchema({ type: 'string' })
      expect(out.type).toBe('string')
      expect(out).not.toHaveProperty('nullable')
    })
  })
})
