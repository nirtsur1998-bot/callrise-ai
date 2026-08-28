// M28 Part 4 — "open Rise about this client" from anywhere in the app (a
// contact page, a deal page, a call page). Same single-listener shape as
// liveCallNav.ts: MainApp owns `active`, so out-of-tree callers signal it
// through one module-level slot instead of threading props through every
// screen in between. A no-op when MainApp isn't mounted — never throws.
export interface AssistantScopeRequest {
  contactId: string
  /** Optional — the Rise screen resolves a missing name from the contact
   *  record itself, so callers that only know an id (a call page) can still
   *  open a scoped conversation. */
  contactName?: string
  company?: string
  dealId?: string
  dealTitle?: string
}

let listener: ((scope: AssistantScopeRequest) => void) | null = null

/** Called once by MainApp in an effect. */
export function setOpenAssistantListener(
  fn: ((scope: AssistantScopeRequest) => void) | null
): void {
  listener = fn
}

/** Open the assistant section in the context of one client. */
export function openAssistantFor(scope: AssistantScopeRequest): void {
  listener?.(scope)
}
