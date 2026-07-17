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
  notes?: string
  createdAt: string
  updatedAt: string
  comments?: ContactComment[]
}
