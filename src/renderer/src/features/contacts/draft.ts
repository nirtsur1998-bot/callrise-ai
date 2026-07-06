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
    notes: ''
  }
}
