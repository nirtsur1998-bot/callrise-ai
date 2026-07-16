import { createContext, useContext } from 'react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastApi {
  success: (message: string, action?: ToastAction) => void
  error: (message: string, action?: ToastAction) => void
  info: (message: string, action?: ToastAction) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

/** App-wide toasts. Call `useToast()` and fire `.success/.error/.info`, with an
 *  optional action (e.g. Undo). Silent `catch {}` paths finally have a voice. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
