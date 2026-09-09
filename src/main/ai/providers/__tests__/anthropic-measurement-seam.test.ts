// BUG-234 — the measurement seam must stay out of production.
//
// AnthropicProvider takes an optional `{ forceToolCalling: true }` so the
// BUG-234 baseline can run BOTH mechanisms on the SAME model. Without that,
// the only available comparison is Haiku-with-structured-output against
// Sonnet-with-tool-calls, which varies model and mechanism together and can
// credit the migration for a model difference.
//
// A seam that exists for measurement is a seam that can be reached by
// accident. This is the whole guard: exactly one production construction site,
// and it passes no options.
//
// The direction of the override is itself a safety property, asserted below:
// it can only ever move the provider toward the OLD forced-tool path, never
// toward structured output on a model that may not honour it. So the failure
// mode of a stale or stray override is "behaves like it did before BUG-234",
// not "sends a schema somewhere untested".
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnthropicProvider } from '../anthropic'

const SRC_DIR = join(__dirname, '..', '..', '..', '..')

/** Every .ts under src/, minus tests — the container the claim is about.
 *  Enumerated rather than spot-checked: naming the files I already know about
 *  is how a second call site added later goes unnoticed. */
function productionSources(): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue
        walk(p)
      } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
        out.push(p)
      }
    }
  }
  walk(SRC_DIR)
  return out
}

describe('BUG-234 — the measurement seam is not reachable from production', () => {
  it('exactly one production file constructs AnthropicProvider, and it passes no options', () => {
    const hits: string[] = []
    for (const file of productionSources()) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ')
      const m = code.match(/new AnthropicProvider\([^)]*\)/g)
      if (m) hits.push(...m.map((s) => `${file.replace(SRC_DIR, 'src')}: ${s}`))
    }
    // One site: registry.ts's build function.
    expect(hits.length, `AnthropicProvider is constructed in ${hits.length} production places:\n${hits.join('\n')}`).toBe(1)
    expect(hits[0]).toContain('new AnthropicProvider(key)')
    expect(
      hits[0],
      'a production call site is passing the measurement seam — it must never set forceToolCalling'
    ).not.toContain('forceToolCalling')
  })

  it('no production file mentions forceToolCalling at all', () => {
    const mentions = productionSources().filter((f) =>
      readFileSync(f, 'utf8').includes('forceToolCalling')
    )
    // anthropic.ts itself defines it; nothing else may name it.
    expect(mentions.map((f) => f.replace(SRC_DIR, 'src'))).toEqual([
      join('src', 'main', 'ai', 'providers', 'anthropic.ts')
    ])
  })

  it('the override can only ever move TOWARD the old forced-tool path', () => {
    // The asymmetry, asserted rather than trusted to the comment. A provider
    // built with the seam OFF behaves exactly like production; built with it
    // ON it declines structured output. There is no setting that turns
    // structured output ON for a model the allowlist excludes.
    const shipped = new AnthropicProvider('sk-test') as unknown as {
      usesStructuredOutput(model: string): boolean
    }
    const forced = new AnthropicProvider('sk-test', { forceToolCalling: true }) as unknown as {
      usesStructuredOutput(model: string): boolean
    }
    // In the allowlist: shipped says yes, the seam can say no.
    expect(shipped.usesStructuredOutput('claude-haiku-4-5')).toBe(true)
    expect(forced.usesStructuredOutput('claude-haiku-4-5')).toBe(false)
    // Outside it: BOTH say no. The seam cannot promote a model.
    expect(shipped.usesStructuredOutput('claude-sonnet-4-6')).toBe(false)
    expect(forced.usesStructuredOutput('claude-sonnet-4-6')).toBe(false)
  })

  it('an absent options argument is identical to an explicit empty one', () => {
    // Guards the default. `opts.forceToolCalling === true` rather than a
    // truthiness check, so an undefined or a stray '' cannot enable it.
    const a = new AnthropicProvider('sk-test') as unknown as { usesStructuredOutput(m: string): boolean }
    const b = new AnthropicProvider('sk-test', {}) as unknown as { usesStructuredOutput(m: string): boolean }
    const c = new AnthropicProvider('sk-test', {
      forceToolCalling: undefined
    }) as unknown as { usesStructuredOutput(m: string): boolean }
    for (const p of [a, b, c]) expect(p.usesStructuredOutput('claude-haiku-4-5')).toBe(true)
  })
})
