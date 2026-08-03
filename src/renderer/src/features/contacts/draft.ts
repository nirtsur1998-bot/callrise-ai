export interface ContactDraft {
  name: string
  company: string
  cid: string
  /** yyyy-mm-dd, or '' for none — matches an <input type="date"> value. */
  registeredAt: string
  /** ISO 3166-1 alpha-2, or undefined for none. */
  country: string | undefined
  email: string
  /** ISO 3166-1 alpha-2 for the phone's dial code, or undefined for none. */
  phoneCountry: string | undefined
  phone: string
  notes: string

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
  dealValue?: number | string
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
  briefingNotes?: string
}

/** @param defaultCountry Settings → CRM's "default country for new contacts"
 *  (ISO 3166-1 alpha-2), or '' for none. */
export function emptyDraft(defaultCountry?: string): ContactDraft {
  return {
    name: '',
    company: '',
    cid: '',
    registeredAt: '',
    country: defaultCountry || undefined,
    email: '',
    phoneCountry: undefined,
    phone: '',
    notes: '',
    industry: '',
    companySize: '',
    website: '',
    registrationNumber: '',
    verificationStatus: '',
    title: '',
    decisionAuthority: '',
    otherStakeholders: '',
    dealValue: undefined,
    pipelineStage: '',
    leadSource: '',
    budgetIndication: '',
    timeline: '',
    competitors: '',
    knownObjections: '',
    currentTooling: '',
    lastContactDate: '',
    preferredLanguage: '',
    communicationStyle: '',
    timezone: '',
    personalNotes: '',
    briefingNotes: ''
  }
}
