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
}
