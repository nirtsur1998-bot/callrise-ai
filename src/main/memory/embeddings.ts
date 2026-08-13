// M25 Sales Brain — local embeddings via transformers.js. No API key, no
// network call per-embedding, no per-token cost — this runs entirely on the
// user's own machine (spec's headline privacy claim: "your sales brain
// never leaves your device"). The ONE exception is the model file itself:
// the first time this app ever computes an embedding, transformers.js
// downloads the ~23MB quantized all-MiniLM-L6-v2 model from the Hugging
// Face CDN and caches it locally under userData — that's a one-time,
// content-only download (model weights, never anything about the user or
// their calls), same category as downloading a font or an icon set, not a
// "leaves your device" privacy exception. Every embedding computed AFTER
// that first download is 100% local and offline.
import { join } from 'node:path'
import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers'

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

let configured = false
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

/** Must be called once, early in startup (before any embedText() call),
 *  same convention as loadStoredAiKeysIntoEnv() being awaited before the
 *  rest of registration in index.ts. Points transformers.js's model cache
 *  at a folder under userData — the default cache location isn't
 *  guaranteed writable in a packaged app, and userData is where this app's
 *  own established convention already puts every other piece of local
 *  state. */
export function configureEmbeddingsCacheDir(userDataDir: string): void {
  if (configured) return
  env.cacheDir = join(userDataDir, 'memory-model-cache')
  env.allowLocalModels = false
  configured = true
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', EMBEDDING_MODEL, { quantized: true })
  }
  return extractorPromise
}

/**
 * M26 Batch 5 — pull the ~23MB model down ahead of time, so the first
 * feature that needs an embedding isn't the one that pays for it.
 *
 * Phase 0 row 37 found this had already caused a real production slowdown:
 * the download is lazy, so it ambushes whatever unrelated feature happens to
 * trigger the first embedding and stalls it for up to ~48s with no
 * explanation anywhere. Warming up at launch trades an invisible random
 * stall for a visible, expected one, at the moment people are most tolerant
 * of setup work.
 *
 * Safe to call at any time and any number of times: getExtractor() memoises
 * its promise, so a real embedText() racing this one awaits the SAME
 * download rather than starting a second. NOTHING is ever blocked on this —
 * it runs fire-and-forget from a background job, and an embedText() arriving
 * mid-download waits exactly as long as it would have anyway, never longer.
 *
 * Resolves rather than rejects on failure: a model that can't be fetched
 * (offline, blocked) must leave the app entirely usable, and the next real
 * embedText() surfaces the problem to whoever actually needed it.
 */
export async function warmUpEmbeddings(): Promise<void> {
  try {
    await getExtractor()
  } catch {
    // Deliberately swallowed — see above. The memoised REJECTED promise is
    // cleared so a later embedText() genuinely retries rather than
    // inheriting this failure for the rest of the session.
    extractorPromise = null
  }
}

/** Embeds one short statement (a single memory's `statement` text — the
 *  spec is explicit this runs at the individual-fact level, "well within
 *  the model's input limits", never a whole transcript). Returns a plain
 *  Float32Array, ready to hand straight to memories-store.ts's blob
 *  encoding — never a raw Tensor, so nothing outside this module needs to
 *  know transformers.js's own output shape. */
export async function embedText(text: string): Promise<Float32Array> {
  const extractor = await getExtractor()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  const data = output.data as Float32Array
  if (data.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${data.length}`)
  }
  return data
}

/** Test/dev-only escape hatch — lets a test inject a fake extractor instead
 *  of downloading/running the real ~23MB model, the same way this codebase
 *  avoids hitting real AI providers in tests. Never called from production
 *  code. */
export function __setExtractorForTests(fn: FeatureExtractionPipeline | null): void {
  extractorPromise = fn ? Promise.resolve(fn) : null
}
