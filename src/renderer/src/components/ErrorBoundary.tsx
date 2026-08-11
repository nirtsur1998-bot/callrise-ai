import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './Button'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Last line of defense for the renderer: without this, an uncaught exception
 * during render (e.g. reading a property off settings/call data that isn't
 * shaped the way this screen expects) unmounts the entire React tree, which
 * reads to the user as "the app crashed" and forces a full relaunch. This
 * catches it, logs it to the same field-diagnostic log main.tsx already
 * writes to, and offers a reload instead of a dead window.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    void window.api.app.logRendererError('ErrorBoundary', error.stack ?? error.message)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-warning-soft">
          <AlertTriangle className="h-5 w-5 text-warning" strokeWidth={2} />
        </div>
        <div>
          <p className="font-medium text-ink">Something went wrong</p>
          <p className="mt-1 max-w-sm text-[13px] text-muted">
            This screen hit an unexpected error. Your data is safe — reload to pick back up.
          </p>
        </div>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    )
  }
}
