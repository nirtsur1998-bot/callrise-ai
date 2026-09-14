// Renderer-side contact types. These mirror the shapes exposed by the preload
// bridge (see src/preload/index.d.ts); kept local so the feature is
// self-contained, matching the tasks/calls convention.

/** A comment left on a contact — either the rep's own note, or an AI-drafted
 *  one from a linked call (opt-in, Settings → CRM → "Auto-generate notes"). */
export interface ContactComment {
  id: string
  text: string
  createdAt: string
  source: 'user' | 'ai'
}

/** M39 §8 — one dated fact about a contact (main: contact-facts.ts). Read-only
 *  in the renderer: history is written by the store, never sent in a patch. */
export interface ContactFact {
  id: string
  field:
    | 'company'
    | 'title'
    | 'decisionAuthority'
    | 'budgetIndication'
    | 'timeline'
    | 'competitors'
    | 'currentTooling'
    | 'knownObjections'
    | 'otherStakeholders'
    | 'dealValue'
    | 'personalNotes'
    | 'notes'
    | 'briefingNotes'
  /** null = cleared (and redacted). */
  value: string | number | null
  validFrom: string
  validFromSource: 'call' | 'stated' | 'approx'
  validUntil?: string
  recordedAt: string
  supersededBy?: string
  source: 'user' | 'ai-accepted' | 'import'
  callId?: string
  redacted?: true
}

export interface Contact {
  id: string
  name: string
  company?: string
  cid?: string
  registeredAt?: string
  country?: string
  email?: string
  phoneCountry?: string
  phone?: string
  /** E.164, computed by toE164() at write time — see lib/countries.ts. */
  phoneE164?: string
  notes?: string

  // --- KYC / Business (M19) ---
  industry?: string
  companySize?: string
  website?: string
  registrationNumber?: string
  verificationStatus?: string
  title?: string
  decisionAuthority?: string
  otherStakeholders?: string

  // --- Deal Context (M19) ---
  dealValue?: number
  pipelineStage?: string
  leadSource?: string
  budgetIndication?: string
  timeline?: string
  competitors?: string
  knownObjections?: string
  currentTooling?: string
  lastContactDate?: string

  // --- Personal / Soft (M19) ---
  preferredLanguage?: string
  communicationStyle?: string
  timezone?: string
  personalNotes?: string

  // --- Briefing (M19) ---
  /** "Anything else the AI should know before I meet this person" — the
   *  highest-value input to the Task 3B pre-meeting brief. */
  briefingNotes?: string

  createdAt: string
  updatedAt: string
  comments?: ContactComment[]
  /** M39 §8 — bi-temporal history of the dated fields; absent until the first dated write. */
  factHistory?: ContactFact[]
}
