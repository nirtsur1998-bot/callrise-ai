import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { TaskType, TaskPriority } from './types'
import type { TaskDraft } from './draft'
import { TASK_TYPE_META, TASK_TYPE_ORDER, PRIORITY_META, PRIORITY_ORDER } from './meta'
import { isoToDateInputValue, dateInputValueToIso } from './format'

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

interface TaskEditorProps {
  value: TaskDraft
  onChange: (next: TaskDraft) => void
  autoFocus?: boolean
}

/** A compact form for one task's fields. Fully controlled by the parent. */
export function TaskEditor({ value, onChange, autoFocus }: TaskEditorProps): React.JSX.Element {
  const set = (patch: Partial<TaskDraft>): void => onChange({ ...value, ...patch })

  return (
    <div className="space-y-3">
      <Field label="Task">
        <input
          type="text"
          value={value.title}
          autoFocus={autoFocus}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="What needs to happen?"
          className={fieldClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select
            value={value.type}
            onChange={(e) => set({ type: e.target.value as TaskType })}
            className={fieldClass}
          >
            {TASK_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {TASK_TYPE_META[t].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select
            value={value.priority}
            onChange={(e) => set({ priority: e.target.value as TaskPriority })}
            className={fieldClass}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_META[p].label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Due date">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={isoToDateInputValue(value.dueAt)}
              onChange={(e) => set({ dueAt: dateInputValueToIso(e.target.value) })}
              className={fieldClass}
            />
            {value.dueAt && (
              <button
                type="button"
                onClick={() => set({ dueAt: undefined })}
                title="Clear due date"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-faint transition hover:bg-elevated hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </Field>
        <Field label="Client (optional)">
          <input
            type="text"
            value={value.clientName}
            onChange={(e) => set({ clientName: e.target.value })}
            placeholder="e.g. Acme Corp"
            className={fieldClass}
          />
        </Field>
      </div>

      <Field label="Note (optional)">
        <input
          type="text"
          value={value.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="A line of context"
          className={fieldClass}
        />
      </Field>
    </div>
  )
}
