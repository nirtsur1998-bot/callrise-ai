// BUG-277 — vitest `setupFiles` entry: strip the developer's provider keys
// from process.env before any test file is imported. The logic and the reason
// live in ./strip-provider-env.ts; this file is only the side effect, kept
// apart so the pin test can import the pattern without triggering the strip.
import { stripProviderEnv } from './strip-provider-env'

stripProviderEnv(process.env)
