export interface DealDraft {
  title: string
  contactId: string | undefined
  stageId: string
  /** Kept as text while editing; parsed to a number on submit. */
  value: string
  /** yyyy-mm-dd, or '' for none — matches an <input type="date"> value. */
  expectedCloseDate: string
  notes: string
}

export function emptyDraft(defaultStageId: string): DealDraft {
  return {
    title: '',
    contactId: undefined,
    stageId: defaultStageId,
    value: '',
    expectedCloseDate: '',
    notes: ''
  }
}
