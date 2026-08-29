import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { isMac } from '@renderer/lib/platform'
import { X } from 'lucide-react'

interface Shortcut {
  label: string
  keys: string
}

interface ShortcutGroup {
  title: string
  shortcuts: Shortcut[]
}

/** M31 Stage 2 — `navPreviewEnabled` gates the ⌘1-7 row so this sheet never
 *  advertises a shortcut that isn't actually registered (MainApp only wires
 *  digit shortcuts while the preview nav is on — see its own keydown
 *  handler for why: a digit-per-item scheme stops being a clean mnemonic
 *  once there are more than ~9 items, which the legacy 12-item nav is). */
function buildGroups(navPreviewEnabled: boolean): ShortcutGroup[] {
  const mod = isMac ? '⌘' : 'Ctrl '
  return [
    {
      title: 'Navigation',
      shortcuts: [
        { label: 'Jump to a screen, contact, deal, or call', keys: `${mod}K` },
        ...(navPreviewEnabled
          ? [{ label: 'Jump to a section by number (1-7)', keys: `${mod}1…${mod}7` }]
          : [])
      ]
    },
    {
      title: 'Command palette',
      shortcuts: [
        { label: 'Navigate results', keys: '↑↓' },
        { label: 'Open selection', keys: '↵' },
        { label: 'Close', keys: 'Esc' }
      ]
    },
    {
      title: 'Actions',
      shortcuts: [
        { label: 'Start a live call', keys: `${mod}⇧L` },
        { label: 'New calendar event', keys: `${mod}⇧E` },
        { label: 'Toggle theme', keys: `${mod}⇧T` }
      ]
    },
    {
      title: 'Anywhere',
      shortcuts: [{ label: 'Close any dialog', keys: 'Esc' }]
    },
    {
      title: 'Call detection (works even when CallRise AI is in the background)',
      shortcuts: [
        { label: 'Stop capturing', keys: '⌘⇧S' },
        { label: 'Pause / resume detection', keys: '⌘⇧P' }
      ]
    },
    {
      title: 'Help',
      shortcuts: [{ label: 'Show keyboard shortcuts', keys: '?' }]
    }
  ]
}

/** Global keyboard-shortcuts cheat sheet, opened with `?` from anywhere in
 *  the app (outside text inputs). Reuses the shared Modal shell, which already
 *  owns the backdrop, focus-trap, Escape-to-close, and scroll-lock. */
export function ShortcutsOverlay({
  open,
  onClose,
  navPreviewEnabled = false
}: {
  open: boolean
  onClose: () => void
  navPreviewEnabled?: boolean
}): React.JSX.Element | null {
  if (!open) return null
  const GROUPS = buildGroups(navPreviewEnabled)

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
