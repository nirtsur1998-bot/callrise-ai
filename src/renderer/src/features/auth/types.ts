// The safe, renderer-side view of the signed-in user. Mirrors the shape the
// main process sends over the IPC bridge (see src/preload/index.d.ts) — never
// includes tokens.
export interface AuthUser {
  id: string
  email: string
  name?: string
}
