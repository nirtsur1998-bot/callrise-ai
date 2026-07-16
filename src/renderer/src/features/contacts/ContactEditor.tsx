import type { ReactNode } from 'react'
import { CountrySelect } from '@renderer/components/CountrySelect'
import { fieldClass } from '@renderer/components/field'
import type { ContactDraft } from './draft'

function Field({
  label,
  required,
  children
}: {
  label: string
  required?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  )
}

interface ContactEditorProps {
  value: ContactDraft
  onChange: (next: ContactDraft) => void
  autoFocus?: boolean
}

/** A compact form for one contact's fields. Fully controlled by the parent. */
export function ContactEditor({
  value,
  onChange,
  autoFocus
}: ContactEditorProps): React.JSX.Element {
  const set = (patch: Partial<ContactDraft>): void => onChange({ ...value, ...patch })

  return (
    <div className="space-y-3">
      <Field label="Name" required>
        <input
          type="text"
          value={value.name}
          autoFocus={autoFocus}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Jamie Chen"
          className={fieldClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Company">
          <input
            type="text"
            value={value.company}
            onChange={(e) => set({ company: e.target.value })}
            placeholder="e.g. Acme Corp"
            className={fieldClass}
          />
        </Field>
        <Field label="Customer No.">
          <input
            type="text"
            value={value.cid}
            onChange={(e) => set({ cid: e.target.value })}
            placeholder="e.g. CID-00123"
            className={fieldClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Country">
          <CountrySelect
            value={value.country}
            onChange={(code) => set({ country: code })}
            placeholder="Select country"
          />
        </Field>
        <Field label="Registered date">
          <input
            type="date"
            value={value.registeredAt}
            onChange={(e) => set({ registeredAt: e.target.value })}
            className={fieldClass}
          />
        </Field>
      </div>

      <Field label="Email">
        <input
          type="email"
          value={value.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="jamie@acme.com"
          className={fieldClass}
        />
      </Field>

      <Field label="Phone">
        <div className="grid grid-cols-[minmax(0,7.5rem)_1fr] gap-2">
          <CountrySelect
            value={value.phoneCountry}
            onChange={(code) => set({ phoneCountry: code })}
            mode="phone"
            placeholder="Code"
          />
          <input
            type="tel"
            value={value.phone}
            onChange={(e) => set({ phone: e.target.value })}
            placeholder="(555) 123-4567"
            className={fieldClass}
          />
        </div>
      </Field>

      <Field label="Notes">
        <textarea
          value={value.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="Anything worth remembering about this person"
          rows={4}
          className={fieldClass}
        />
      </Field>
    </div>
  )
}
