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

      {/* --- KYC / Business (M19) --- */}
      <fieldset className="border-t border-line pt-4">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Business & KYC
        </legend>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Industry">
              <input
                type="text"
                value={value.industry || ''}
                onChange={(e) => set({ industry: e.target.value })}
                placeholder="e.g. SaaS, Fintech"
                className={fieldClass}
              />
            </Field>
            <Field label="Company Size">
              <input
                type="text"
                value={value.companySize || ''}
                onChange={(e) => set({ companySize: e.target.value })}
                placeholder="e.g. 1-10, 50-250"
                className={fieldClass}
              />
            </Field>
          </div>

          <Field label="Website">
            <input
              type="url"
              value={value.website || ''}
              onChange={(e) => set({ website: e.target.value })}
              placeholder="https://acme.com"
              className={fieldClass}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Registration No.">
              <input
                type="text"
                value={value.registrationNumber || ''}
                onChange={(e) => set({ registrationNumber: e.target.value })}
                placeholder="e.g. VAT-123"
                className={fieldClass}
              />
            </Field>
            <Field label="Verification">
              <input
                type="text"
                value={value.verificationStatus || ''}
                onChange={(e) => set({ verificationStatus: e.target.value })}
                placeholder="verified, pending, failed"
                className={fieldClass}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Job Title">
              <input
                type="text"
                value={value.title || ''}
                onChange={(e) => set({ title: e.target.value })}
                placeholder="e.g. VP Sales"
                className={fieldClass}
              />
            </Field>
            <Field label="Decision Authority">
              <input
                type="text"
                value={value.decisionAuthority || ''}
                onChange={(e) => set({ decisionAuthority: e.target.value })}
                placeholder="e.g. Sole, Committee"
                className={fieldClass}
              />
            </Field>
          </div>

          <Field label="Other Stakeholders">
            <textarea
              value={value.otherStakeholders || ''}
              onChange={(e) => set({ otherStakeholders: e.target.value })}
              placeholder="Key decision-makers, budget owners, etc."
              rows={2}
              className={fieldClass}
            />
          </Field>
        </div>
      </fieldset>

      {/* --- Deal Context (M19) --- */}
      <fieldset className="border-t border-line pt-4">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Deal Context
        </legend>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Deal Value">
              <input
                type="number"
                value={value.dealValue || ''}
                onChange={(e) => set({ dealValue: e.target.value ? Number(e.target.value) : undefined })}
                placeholder="e.g. 50000"
                className={fieldClass}
              />
            </Field>
            <Field label="Pipeline Stage">
              <input
                type="text"
                value={value.pipelineStage || ''}
                onChange={(e) => set({ pipelineStage: e.target.value })}
                placeholder="e.g. Negotiation"
                className={fieldClass}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Lead Source">
              <input
                type="text"
                value={value.leadSource || ''}
                onChange={(e) => set({ leadSource: e.target.value })}
                placeholder="e.g. Inbound, Cold"
                className={fieldClass}
              />
            </Field>
            <Field label="Budget Indication">
              <input
                type="text"
                value={value.budgetIndication || ''}
                onChange={(e) => set({ budgetIndication: e.target.value })}
                placeholder="e.g. Approved, TBD"
                className={fieldClass}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Timeline">
              <input
                type="text"
                value={value.timeline || ''}
                onChange={(e) => set({ timeline: e.target.value })}
                placeholder="e.g. Q1, ASAP"
                className={fieldClass}
              />
            </Field>
            <Field label="Last Contact">
              <input
                type="date"
                value={value.lastContactDate || ''}
                onChange={(e) => set({ lastContactDate: e.target.value })}
                className={fieldClass}
              />
            </Field>
          </div>

          <Field label="Competitors">
            <textarea
              value={value.competitors || ''}
              onChange={(e) => set({ competitors: e.target.value })}
              placeholder="Their existing solutions, alternatives they're considering"
              rows={2}
              className={fieldClass}
            />
          </Field>

          <Field label="Known Objections">
            <textarea
              value={value.knownObjections || ''}
              onChange={(e) => set({ knownObjections: e.target.value })}
              placeholder="Price concerns, integration challenges, etc."
              rows={2}
              className={fieldClass}
            />
          </Field>

          <Field label="Current Tooling">
            <textarea
              value={value.currentTooling || ''}
              onChange={(e) => set({ currentTooling: e.target.value })}
              placeholder="Their current software stack and services"
              rows={2}
              className={fieldClass}
            />
          </Field>
        </div>
      </fieldset>

      {/* --- Personal / Soft (M19) --- */}
      <fieldset className="border-t border-line pt-4">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Personal & Communication
        </legend>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Preferred Language">
              <input
                type="text"
                value={value.preferredLanguage || ''}
                onChange={(e) => set({ preferredLanguage: e.target.value })}
                placeholder="e.g. English"
                className={fieldClass}
              />
            </Field>
            <Field label="Style">
              <input
                type="text"
                value={value.communicationStyle || ''}
                onChange={(e) => set({ communicationStyle: e.target.value })}
                placeholder="Formal, casual, email-first"
                className={fieldClass}
              />
            </Field>
            <Field label="Timezone">
              <input
                type="text"
                value={value.timezone || ''}
                onChange={(e) => set({ timezone: e.target.value })}
                placeholder="America/New_York"
                className={fieldClass}
              />
            </Field>
          </div>

          <Field label="Personal Notes">
            <textarea
              value={value.personalNotes || ''}
              onChange={(e) => set({ personalNotes: e.target.value })}
              placeholder="Has two kids, mentions cycling, early riser, prefers video calls"
              rows={2}
              className={fieldClass}
            />
          </Field>
        </div>
      </fieldset>

      {/* --- Briefing (M19, highest priority) --- */}
      <fieldset className="border-t border-line pt-4">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
          Pre-meeting Brief
        </legend>
        <Field label="Anything else the AI should know">
          <textarea
            value={value.briefingNotes || ''}
            onChange={(e) => set({ briefingNotes: e.target.value })}
            placeholder="Red flags, strategic goals, key relationships, wins/losses — this is the highest-value input for AI-generated meeting briefs"
            rows={5}
            className={fieldClass}
          />
        </Field>
      </fieldset>
    </div>
  )
}
