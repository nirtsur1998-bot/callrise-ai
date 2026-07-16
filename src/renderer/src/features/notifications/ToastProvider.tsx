import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Check, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { ToastContext, type ToastAction, type ToastKind } from './useToast'

interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: ToastAction
}

const ICON: Record<ToastKind, typeof Check> = {
  success: Check,
  error: AlertTriangle,
  info: Info
}
const DOT: Record<ToastKind, string> = {
  success: 'text-positive',
  error: 'text-danger',
  info: 'text-accent'
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string, action?: ToastAction) => {
      const id = nextId.current++
      setToasts((list) => [...list, { id, kind, message, action }])
      // Actions (undo) linger a little longer so they're reachable.
      window.setTimeout(() => dismiss(id), action ? 6500 : 4000)
    },
    [dismiss]
  )

  const success = useCallback((m: string, a?: ToastAction) => push('success', m, a), [push])
  const error = useCallback((m: string, a?: ToastAction) => push('error', m, a), [push])
  const info = useCallback((m: string, a?: ToastAction) => push('info', m, a), [push])

  return (
    <ToastContext.Provider value={{ success, error, info }}>
      {children}
      <div
        className="pointer-events-none fixed right-6 bottom-6 z-[60] flex w-80 flex-col gap-2"
        role="region"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((t) => {
          const Icon = ICON[t.kind]
          return (
            <div
              key={t.id}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className="animate-pop pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line-soft bg-elevated px-3.5 py-3 text-[13px] shadow-pop"
            >
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', DOT[t.kind])} strokeWidth={2.25} />
              <p className="min-w-0 flex-1 text-ink">{t.message}</p>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick()
                    dismiss(t.id)
                  }}
                  className="press shrink-0 font-medium text-accent hover:brightness-110"
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="press -mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
