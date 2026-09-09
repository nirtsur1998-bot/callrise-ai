// BUG-240 — structured output never worked, and the tests could not tell.
//
// M37 shipped `output_config.format` on the request and read `parsed_output`
// off the response. There is no `parsed_output`. Measured against the live API
// on 2026-09-09:
//
//   top-level keys : model, id, type, role, content, container, stop_reason,
//                    stop_sequence, stop_details, usage
//   content        : [{ type: 'text',
//                       text: '{"title": "Acme Co — Renewal Pricing Discussion"}' }]
//
// So the branch never fired, the tool_use lookup after it found nothing (no
// tools are sent on that path by design), and every structured-output call
// threw 'The model did not return the expected structured output.' — while the
// model answered correctly on every single one. In production that routed
// coaching-cue, deal-tier1 and memory-extract (MODEL_BY_PURPOSE -> Haiku 4.5)
// into the fallback chain on every call from 1.11.0.
//
// WHY THE EXISTING TESTS PASSED THROUGH ALL OF IT, which is the part worth
// keeping: anthropic-structured-output.test.ts asserts the REQUEST — that
// tools/tool_choice are omitted and output_config is set. All of that was and
// is correct. Nothing asserted what comes BACK, because doing so needs a
// response shape, and the response shape had been asserted in a comment
// instead of observed. A test suite that only checks what you send cannot
// catch a wrong belief about what you receive.
//
// So these tests are written against the RECORDED REAL RESPONSE above, not
// against a shape I would now be inventing a second time.
import { describe, expect, it } from 'vitest'
import { parseStructuredText, schemaFitsStructuredOutput } from '../anthropic'

describe('BUG-240 — the answer is a text block, not parsed_output', () => {
  it('reads the object out of the text block the API actually returns', () => {
    // Verbatim from the probe against the live API.
    const content = [{ type: 'text', text: '{"title": "Acme Co — Renewal Pricing Discussion"}' }]
    expect(parseStructuredText(content)).toEqual({ title: 'Acme Co — Renewal Pricing Discussion' })
  })

  it('handles a nested object, which is what every non-trivial schema returns', () => {
    const content = [
      { type: 'text', text: '{"tasks":[{"title":"Send pricing","type":"email","priority":"high","dueInDays":2}]}' }
    ]
    const out = parseStructuredText(content)
    expect(Array.isArray(out?.tasks)).toBe(true)
    expect((out?.tasks as unknown[]).length).toBe(1)
  })

  it('returns null rather than throwing when the text is not JSON', () => {
    // The model answering in prose is a real outcome; the caller's own
    // fallback decides what to do with it (call-title.ts takes the prose).
    expect(parseStructuredText([{ type: 'text', text: 'Acme renewal call' }])).toBeNull()
  })

  it('refuses a bare array or scalar — the contract is an OBJECT', () => {
    // toolInput is Record<string, unknown>. A JSON array parses fine and would
    // sail through a naive truthiness check into a caller expecting fields.
    expect(parseStructuredText([{ type: 'text', text: '[1,2,3]' }])).toBeNull()
    expect(parseStructuredText([{ type: 'text', text: '"just a string"' }])).toBeNull()
    expect(parseStructuredText([{ type: 'text', text: '42' }])).toBeNull()
    expect(parseStructuredText([{ type: 'text', text: 'null' }])).toBeNull()
  })

  it('returns null when there is no text block at all', () => {
    expect(parseStructuredText([])).toBeNull()
    expect(parseStructuredText([{ type: 'tool_use' }])).toBeNull()
  })
})

describe('BUG-240 — json_schema mode accepts a SUBSET of JSON Schema', () => {
  // Measured: 400 invalid_request_error — "output_config.format.schema: For
  // 'integer' type, properties maximum, minimum are not supported". A forced
  // tool call accepts the same schema without complaint, which is why this
  // only appeared when the schema moved mechanisms.
  it('refuses a schema with minimum/maximum on an integer', () => {
    expect(
      schemaFitsStructuredOutput({
        type: 'object',
        properties: { score: { type: 'integer', minimum: 0, maximum: 10 } }
      })
    ).toBe(false)
  })

  it('finds it however deeply it is nested — coach.ts buries it in an array of objects', () => {
    expect(
      schemaFitsStructuredOutput({
        type: 'object',
        properties: {
          dimensions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { score: { type: 'number', minimum: 1, maximum: 5 } }
            }
          }
        }
      })
    ).toBe(false)
  })

  it('accepts an ordinary schema', () => {
    expect(
      schemaFitsStructuredOutput({
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false
      })
    ).toBe(true)
  })

  it('does NOT refuse minimum/maximum on a string or array — the API only rejects it on numerics', () => {
    // Over-refusing costs the better mechanism for no reason. The check is as
    // narrow as the measured error message, not as wide as the keyword.
    expect(
      schemaFitsStructuredOutput({
        type: 'object',
        properties: { name: { type: 'string', minimum: 1 } }
      })
    ).toBe(true)
  })

  it('rots the safe way: an unknown keyword is allowed through', () => {
    // Same direction as the model allowlist. A keyword this function has never
    // heard of keeps the better mechanism; only the things measured to 400 are
    // avoided. The failure mode of staleness is "we used structured output and
    // it worked", not "we refused something that was fine".
    expect(
      schemaFitsStructuredOutput({
        type: 'object',
        properties: { x: { type: 'string', someFutureKeyword: true } }
      })
    ).toBe(true)
  })
})
