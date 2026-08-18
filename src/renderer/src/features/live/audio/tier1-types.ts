// Shared shape of the Tier 1 status the main process broadcasts.
//
// Declared here rather than imported from src/main/tier1.ts because the
// renderer must not pull main-process modules (electron, net, fs) into its
// bundle. Kept structurally identical to Tier1Status there; the fields are
// documented at length at the source of truth.
export interface Tier1Status {
  engineAvailable: boolean
  engineRunning: boolean
  /** Pipe is connected. DOES NOT mean audio is being denoised. */
  connected: boolean
  /** true = model loaded and audio genuinely cleaned. false = PASSTHROUGH.
   *  null = unknown, and treated exactly like false by every consumer. */
  denoisingActive: boolean | null
  enginePath: string | null
}
