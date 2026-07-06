import { useMemo, useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useKnowledge } from './useKnowledge'
import { EntryFormDialog, type EntryFormValues } from './EntryFormDialog'
import { ContextSizePanel } from './ContextSizePanel'
import { CATEGORY_META, CATEGORY_ORDER } from './meta'
import type { KnowledgeCategory, KnowledgeEntry } from './types'

export function KnowledgeView(): React.JSX.Element {
  const { entries, loading, create, update, remove } = useKnowledge()
  const [category, setCategory] = useState<KnowledgeCategory>('objection')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null)

  const meta = CATEGORY_META[category]
  const visible = useMemo(() => entries.filter((e) => e.category === category), [entries, category])

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Knowledge base</h2>
          <span className="text-[13px] text-faint">{entries.length} total</span>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          <Plus className="h-4 w-4" /> {meta.addLabel}
        </button>
      </div>
      <p className="mb-5 text-[13px] text-faint">
        Your own sales material — later this grounds live cues and call summaries.
      </p>

      <ContextSizePanel refreshKey={entries} />

      {/* Category tabs */}
      <div className="mb-4 flex items-center gap-1">
        {CATEGORY_ORDER.map((id) => {
          const m = CATEGORY_META[id]
          const count = entries.filter((e) => e.category === id).length
          const isActive = category === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setCategory(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition',
                isActive ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-elevated hover:text-ink'
              )}
            >
              <m.icon className="h-3.5 w-3.5" />
              {m.label} <span className={cn(isActive ? 'text-accent' : 'text-faint')}>{count}</span>
            </button>
          )
        })}
      </div>

      <p className="mb-4 text-[13px] text-faint">{meta.description}</p>

      {/* Body */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-faint">Loading…</div>
      ) : visible.length === 0 ? (
        <EmptyCategory category={category} onAdd={() => setAdding(true)} />
      ) : (
        <ul className="space-y-2.5">
          {visible.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onEdit={() => setEditing(entry)}
              onDelete={() => void remove(entry.id)}
            />
          ))}
        </ul>
      )}

      {adding && (
        <EntryFormDialog
          category={category}
          onClose={() => setAdding(false)}
          onSubmit={async (values: EntryFormValues) => {
            await create({ category, ...values })
            setAdding(false)
          }}
        />
      )}
      {editing && (
        <EntryFormDialog
          category={editing.category}
          entry={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (values: EntryFormValues) => {
            await update(editing.id, values)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

interface EntryRowProps {
  entry: KnowledgeEntry
  onEdit: () => void
  onDelete: () => void
}

function EntryRow({ entry, onEdit, onDelete }: EntryRowProps): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)

  return (
    <li>
      <div className="group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
        <div className="min-w-0 flex-1">
          {entry.category === 'objection' ? (
            <>
              <p className="text-sm font-medium">{entry.trigger}</p>
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-muted">{entry.response}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">{entry.title}</p>
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-muted">{entry.body}</p>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {confirm ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                title="Edit"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-ink group-hover:opacity-100"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setConfirm(true)}
                title="Delete"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-rose-300 group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function EmptyCategory({
  category,
  onAdd
}: {
  category: KnowledgeCategory
  onAdd: () => void
}): React.JSX.Element {
  const meta = CATEGORY_META[category]
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
        <meta.icon className="h-6 w-6 text-faint" strokeWidth={1.75} />
      </div>
      <h3 className="text-lg font-semibold">{meta.emptyTitle}</h3>
      <p className="mt-1.5 max-w-xs text-sm text-muted">{meta.emptyBody}</p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
      >
        <Plus className="h-4 w-4" /> {meta.addLabel}
      </button>
    </div>
  )
}
