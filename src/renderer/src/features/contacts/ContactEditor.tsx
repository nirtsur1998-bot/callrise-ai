import type { ReactNode } from 'react'
import { CountrySelect } from '@renderer/components/CountrySelect'
import type { ContactDraft } from './draft'

const fieldClass =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-faint transition focus:border-accent focus:outline-none [color-scheme:dark]'

function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
        {label}
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
      <Field label="Name">
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
        <Field label="Company (optional)">
          <input
            type="text"
            value={value.company}
            onChange={(e) => set({ company: e.target.value })}
            placeholder="e.g. Acme Corp"
            className={fieldClass}
          />
        </Field>
        <Field label="Customer No. (optional)">
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
        <Field label="Country (optional)">
          <CountrySelect
            value={value.country}
            onChange={(code) => set({ country: code })}
            placeholder="Select country"
          />
        </Field>
        <Field label="Registered date (optional)">
          <input
            type="date"
            value={value.registeredAt}
            onChange={(e) => set({ registeredAt: e.target.value })}
            className={fieldClass}
          />
        </Field>
      </div>

      <Field label="Email (optional)">
        <input
          type="email"
          value={value.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="jamie@acme.com"
          className={fieldClass}
        />
      </Field>

      <Field label="Phone (optional)">
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

      <Field label="Notes (optional)">
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
