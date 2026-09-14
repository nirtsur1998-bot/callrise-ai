// BUG-277 — the suite must not inherit the developer's provider keys.
//
// Six `src/main/ai` tests went red on `main` one afternoon after passing on
// the same commit that morning. Nothing in the tree had changed; the machine's
// USER environment had gained real GOOGLE_AI_API_KEY / GROQ_API_KEY /
// OPENROUTER_API_KEY / ANTHROPIC_API_KEY variables. Every AI module reads keys
// from `process.env[keyEnvName]`, and the tests snapshot the inherited
// environment and only add or delete the keys they mean to test — so "a
// Groq-ONLY user" was suddenly a user with Google keyed too, and the fallback
// chain answered accordingly. With the four variables unset, 24 of 24 passed.
//
// THIS FILE HAS NO SIDE EFFECT. The strip itself runs from
// `strip-provider-env.setup.ts` (vitest `setupFiles`, before any test file is
// imported). The split exists because the first version stripped at import
// time, and the pin test that imported it to read the pattern thereby cleaned
// the environment itself — a check that could not fail on the very machine it
// was written for. The pin test now imports only this pure module.
//
// Strips by NAME PATTERN rather than importing the provider registry, because
// the registry pulls in every vendor SDK and the setup runs in every worker;
// `provider-env-stripped.test.ts` pins that the pattern covers every name the
// registry actually reads, so a new provider cannot slip past.
export const PROVIDER_ENV_PATTERN = /(_API_KEY|_ACCOUNT_ID)$/

export function stripProviderEnv(env: NodeJS.ProcessEnv): string[] {
  const stripped: string[] = []
  for (const name of Object.keys(env)) {
    if (PROVIDER_ENV_PATTERN.test(name)) {
      delete env[name]
      stripped.push(name)
    }
  }
  return stripped
}
