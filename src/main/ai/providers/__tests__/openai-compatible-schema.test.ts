// M22 bug hunt: Mistral's Chat Completions endpoint only accepts `max_tokens`
// — sending the OpenAI-current `max_completion_tokens` (what every OTHER
// provider on this shared factory accepts: Groq, OpenRouter, NVIDIA, Cerebras)
// gets the whole request rejected with 422 "Extra inputs are not permitted".
// This broke every Mistral completion AND "Test key" validation (same request
// shape), deterministically, for anyone using Mistral — the same class of bug
// as the Gemini tool-schema issue fixed earlier this session, just a request
// PARAMETER instead of a tool SCHEMA field.
import { describe, expect, it } from 'vitest'
import { resolveMaxTokensField } from '../openai-compatible'

describe('resolveMaxTokensField', () => {
  it('defaults to max_completion_tokens when a provider does not override it', () => {
    expect(resolveMaxTokensField({}, 512)).toEqual({ max_completion_tokens: 512 })
  })

  it('uses max_tokens for a provider configured to need it (Mistral)', () => {
    expect(resolveMaxTokensField({ maxTokensParam: 'max_tokens' }, 512)).toEqual({ max_tokens: 512 })
  })

  it('never sends both fields at once', () => {
    const field = resolveMaxTokensField({ maxTokensParam: 'max_tokens' }, 100)
    expect(Object.keys(field)).toEqual(['max_tokens'])
  })
})
