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
})
