import { useState } from 'react'
import { Mic, Check, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Button } from '@renderer/components/Button'
import { StepHeader } from './StepHeader'

type Status = 'idle' | 'checking' | 'granted' | 'denied'

/** Step: get the OS mic prompt out of the way now instead of ambushing the
 *  user mid-first-call. `mic:ensureAccess` only covers macOS's TCC dialog —
 *  on Windows/Linux the real OS-level prompt is Chromium's own getUserMedia
 *  permission UI, which only fires from a renderer-side call, so this step
 *  makes one directly (open the stream just long enough to resolve the
 *  prompt, then release it immediately — nothing is recorded or kept). */
export function MicAccess(): React.JSX.Element {
  const [status, setStatus] = useState<Status>('idle')

  const request = async (): Promise<void> => {
    setStatus('checking')
    try {
      const macStatus = await window.api.transcription.ensureMicAccess()
      if (macStatus.status === 'denied') {
        setStatus('denied')
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      setStatus('granted')
    } catch {
      setStatus('denied')
    }
  }

  return (
    <div>
      <StepHeader
        title="Microphone access"
        subtitle="CallRise needs this to capture your side of a call. Grant it now so it's not a surprise mid-call."
      />

      <div
        className={cn(
          'flex items-start gap-3 rounded-xl border p-3.5',
          status === 'granted'
            ? 'border-positive/30 bg-positive-soft'
            : status === 'denied'
              ? 'border-warning/30 bg-warning-soft'
              : 'border-line-soft bg-canvas'
        )}
      >
        <span
          className={cn(
            'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
            status === 'granted'
              ? 'bg-positive text-white'
              : status === 'denied'
                ? 'bg-warning text-white'
                : 'bg-elevated text-muted'
          )}
        >
          {status === 'granted' ? (
            <Check className="h-4 w-4" />
          ) : status === 'denied' ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {status === 'granted'
              ? 'Microphone access granted'
              : status === 'denied'
                ? "Microphone access wasn't granted"
                : 'Not requested yet'}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
            {status === 'granted'
              ? "You're set — nothing was recorded just now, this only confirms access."
              : status === 'denied'
                ? 'You can still use CallRise, but a live call will need this later. Try again, or allow it from your OS privacy settings and re-check.'
                : "Click below — your OS will show its own permission prompt. Nothing is recorded, we just check access and release it right away."}
          </p>
          {status !== 'granted' && (
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={() => void request()} disabled={status === 'checking'}>
                {status === 'checking' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Mic className="h-3.5 w-3.5" />
                )}
                {status === 'denied' ? 'Try again' : 'Grant microphone access'}
              </Button>
              {status === 'denied' && (
                <button
                  type="button"
                  onClick={() => void window.api.transcription.openMicSettings()}
                  className="text-[12px] font-medium text-accent hover:underline"
                >
                  Open OS settings
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
