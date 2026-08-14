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
import type { FeatureExtractionPipeline } from '@xenova/transformers'

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

let cacheDir: string | null = null
let configured = false
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

/** Must be called once, early in startup (before any embedText() call),
 *  same convention as loadStoredAiKeysIntoEnv() being awaited before the
 *  rest of registration in index.ts. Points transformers.js's model cache
 *  at a folder under userData — the default cache location isn't
 *  guaranteed writable in a packaged app, and userData is where this app's
 *  own established convention already puts every other piece of local
 *  state.
 *
 *  RECORDS THE PATH ONLY — deliberately does not touch @xenova/transformers.
 *  That module is a static-import away from onnxruntime-node, whose
 *  .node binary links against the Visual C++ runtime (MSVCP140.dll,
 *  VCRUNTIME140.dll, VCRUNTIME140_1.dll — verified with dumpbin). Those are
 *  present on any machine with Visual Studio (every dev box, every CI
 *  runner) and ABSENT on a clean Windows install, where loading it throws
 *  the OS-level "The specified module could not be found"
 *  (ERROR_MOD_NOT_FOUND). This function is the FIRST thing initSalesBrain()
 *  calls, so back when it touched `env` eagerly, that throw took down the
 *  entire Sales Brain init — database and all — on machines missing the
 *  runtime, even though embeddings are only needed for semantic search.
 *  Shipping the runtime alongside the app (electron-builder.yml's
 *  extraFiles) is the actual fix for the missing DLLs; keeping this lazy is
 *  the independent guarantee that a native-load failure can never again
 *  cost more than the one feature that needs it. */
export function configureEmbeddingsCacheDir(userDataDir: string): void {
  if (configured) return
  cacheDir = join(userDataDir, 'memory-model-cache')
  configured = true
}

/** The only place @xenova/transformers is ever loaded, and deliberately
 *  behind a dynamic import so the native backend is pulled in on first real
 *  embedding work — never at startup. Applies the cache dir recorded above
 *  at that point instead of at configure time. */
async function loadTransformers(): Promise<typeof import('@xenova/transformers')> {
  const mod = await import('@xenova/transformers')
  if (cacheDir) {
    mod.env.cacheDir = cacheDir
    mod.env.allowLocalModels = false
  }
  return mod
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = loadTransformers().then((mod) =>
      mod.pipeline('feature-extraction', EMBEDDING_MODEL, { quantized: true })
    )
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
