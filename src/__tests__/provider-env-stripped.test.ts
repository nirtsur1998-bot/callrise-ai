// BUG-277 — pins that the suite runs without the developer's provider keys.
//
// Three claims, each of which can fail on its own:
//   1. every env name the provider registry reads matches the strip pattern
//      (a new provider whose key is named outside the pattern fails here);
//   2. at test time none of those names is present in process.env — which,
//      on a machine whose environment carries real keys, is only true because
//      the setup file ran;
//   3. vitest.config.ts actually names the setup file (a setup file nobody
//      wires in is a guard that cannot fire).
//
// It imports ONLY the pure module. The first draft imported the file that
// strips at load, which cleaned process.env before claim 2 was checked — a
// check that passed without the setup wired in at all. Red-checked since:
// under a config with no setupFiles, claim 2 fails on a machine whose
// environment carries keys.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_ENV_PATTERN, stripProviderEnv } from './setup/strip-provider-env'
import { PROVIDER_REGISTRY } from '../main/ai/registry'

describe('BUG-277 — the developer’s provider keys never reach the suite', () => {
  const names = Object.values(PROVIDER_REGISTRY).flatMap((e) => [
    e.keyEnvName,
    ...(e.requiredEnvNames ?? [])
  ])

  it('the registry reads at least one key name (the pin has a population)', () => {
    expect(names.length).toBeGreaterThan(5)
  })

  it('every env name the registry reads is covered by the strip pattern', () => {
    const uncovered = names.filter((n) => !PROVIDER_ENV_PATTERN.test(n))
    expect(uncovered).toEqual([])
  })

  it('none of those names is set while tests run', () => {
    const present = names.filter((n) => process.env[n] !== undefined)
    expect(present).toEqual([])
  })

  it('the strip removes exactly the matching names and leaves the rest', () => {
    const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'x', CLOUDFLARE_ACCOUNT_ID: 'y', PATH: 'p', HOME: 'h' }
    expect(stripProviderEnv(env).sort()).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'GROQ_API_KEY'])
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH'])
  })

  it('vitest.config.ts wires the setup file in', () => {
    const cfg = readFileSync(join(__dirname, '..', '..', 'vitest.config.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(cfg).toMatch(/setupFiles:\s*\[[^\]]*strip-provider-env\.setup/)
  })
})
