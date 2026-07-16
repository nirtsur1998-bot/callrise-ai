import { useMemo, useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { EmptyState } from '@renderer/components/EmptyState'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
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
      <PageHeader
        title="Knowledge base"
        count={`${entries.length} total`}
        subtitle="Your own sales material — later this grounds live cues and call summaries."
        actions={
          <Button onClick={() => setAdding(true)} icon={Plus}>
            {meta.addLabel}
          </Button>
        }
      />

      <ContextSizePanel refreshKey={entries} />

      {/* Category tabs */}
      <div role="tablist" className="mb-4 flex items-center gap-1">
        {CATEGORY_ORDER.map((id) => {
          const m = CATEGORY_META[id]
          const count = entries.filter((e) => e.category === id).length
          const isActive = category === id
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setCategory(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition focus-visible:ring-2 focus-visible:ring-accent/40',
                isActive ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-elevated hover:text-ink'
              )}
            >
              <m.icon className="h-3.5 w-3.5" />
              {m.label}{' '}
              <span className={cn('press tabular-nums', isActive ? 'text-accent' : 'text-faint')}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      <p className="mb-4 text-[13px] text-faint">{meta.description}</p>

      {/* Body */}
      {loading ? (
        <SkeletonRows />
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
              <p className="text-[10px] font-medium tracking-wide text-faint uppercase">
                When the buyer says
              </p>
              <p className="text-sm font-medium">{entry.trigger}</p>
              <p className="mt-2 text-[10px] font-medium tracking-wide text-faint uppercase">
                You respond
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-muted">{entry.response}</p>
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
              <Button variant="danger" size="sm" onClick={onDelete}>
                Delete
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <IconButton
                icon={Pencil}
                label="Edit entry"
                onClick={onEdit}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              />
              <IconButton
                icon={Trash2}
                label="Delete entry"
                variant="danger"
                onClick={() => setConfirm(true)}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              />
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
    <EmptyState
      icon={meta.icon}
      title={meta.emptyTitle}
      description={meta.emptyBody}
      action={{ label: meta.addLabel, onClick: onAdd, icon: Plus }}
    />
  )
}
