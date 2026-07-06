// Renderer-side contact types. These mirror the shapes exposed by the preload
// bridge (see src/preload/index.d.ts); kept local so the feature is
// self-contained, matching the tasks/calls convention.

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
}
