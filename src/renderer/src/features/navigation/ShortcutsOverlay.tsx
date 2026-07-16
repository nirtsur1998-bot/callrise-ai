import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { X } from 'lucide-react'

interface Shortcut {
  label: string
  keys: string
}

interface ShortcutGroup {
  title: string
  shortcuts: Shortcut[]
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [{ label: 'Jump to a screen', keys: '⌘K' }]
  },
  {
    title: 'Help',
    shortcuts: [{ label: 'Show keyboard shortcuts', keys: '?' }]
  }
]

/** Global keyboard-shortcuts cheat sheet, opened with `?` from anywhere in
 *  the app (outside text inputs). Reuses the shared Modal shell, which already
 *  owns the backdrop, focus-trap, Escape-to-close, and scroll-lock. */
export function ShortcutsOverlay({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  if (!open) return null

  return (
    <Modal onClose={onClose} title="Keyboard shortcuts" size="md">
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>

      <div className="flex flex-col gap-5 px-6 py-5">
        {GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
              {group.title}
            </span>
            <div className="flex flex-col gap-1.5">
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.label} className="flex items-center justify-between gap-4">
                  <span className="text-sm text-muted">{shortcut.label}</span>
                  <kbd className="rounded-md border border-line bg-elevated px-1.5 py-0.5 text-[11px] font-mono text-ink">
                    {shortcut.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
