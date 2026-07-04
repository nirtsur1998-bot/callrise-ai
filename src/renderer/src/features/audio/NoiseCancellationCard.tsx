import { AudioLines, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { useVirtualMic } from './useVirtualMic'

/** Home section: turn app-managed noise cancellation on/off. When on, a helper
 *  cleans the mic and publishes it as the "Sales OS Microphone" device — which
 *  the user then selects in Zoom/Meet (or here) so the buyer hears clean audio. */
export function NoiseCancellationCard(): React.JSX.Element {
  const { status, busy, start, stop } = useVirtualMic()

  // Loading the very first status.
  if (status === null) {
    return (
      <Card className="mb-5">
        <div className="flex items-center gap-2 text-[13px] text-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking noise cancellation…
        </div>
      </Card>
    )
  }

  const { driverInstalled, helperAvailable, helperRunning, denoiseActive } = status
  const setUp = driverInstalled && helperAvailable
  const on = helperRunning && denoiseActive

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AudioLines className={cn('h-4 w-4', on ? 'text-accent' : 'text-faint')} />
          <h3 className="text-sm font-medium">Noise cancellation</h3>
        </div>

        {setUp ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => (helperRunning ? void stop() : void start())}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition disabled:opacity-60',
              helperRunning
                ? 'border border-line bg-surface text-ink hover:bg-elevated'
                : 'bg-accent text-white hover:opacity-90'
            )}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {helperRunning ? 'Turn off' : 'Turn on'}
          </button>
        ) : null}
      </div>

      {/* Not set up: the driver isn't installed yet. */}
      {!driverInstalled && (
        <div className="rounded-xl border border-line-soft bg-canvas p-3">
          <p className="flex items-start gap-1.5 text-[13px] text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The &ldquo;Sales OS Microphone&rdquo; audio device isn&rsquo;t installed yet.
          </p>
          <p className="mt-1.5 text-[11px] text-faint">
            One-time setup installs a system audio device and needs your admin password. Once
            it&rsquo;s in place, you can turn noise cancellation on here.
          </p>
        </div>
      )}

      {/* Driver present but the helper binary is missing (dev edge case). */}
      {driverInstalled && !helperAvailable && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          The noise-cancellation engine couldn&rsquo;t be found on disk.
        </p>
      )}

      {/* Set up + on. */}
      {setUp && on && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <p className="flex items-center gap-1.5 text-[13px] text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> On — your voice is being cleaned.
          </p>
          <p className="mt-1.5 text-[11px] text-faint">
            In your call app (Zoom, Meet, …) pick{' '}
            <span className="font-medium text-muted">&ldquo;Sales OS Microphone&rdquo;</span> as the
            microphone so the other person hears the clean audio.
          </p>
        </div>
      )}

      {/* Set up + running but the denoiser fell back to raw passthrough. */}
      {setUp && helperRunning && !denoiseActive && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          Running, but the denoiser didn&rsquo;t load — audio is passing through uncleaned.
        </p>
      )}

      {/* Set up + off. */}
      {setUp && !helperRunning && (
        <p className="text-[11px] text-faint">
          Off. Turn it on to clean your microphone, then select &ldquo;Sales OS Microphone&rdquo; in
          your call app.
        </p>
      )}
    </Card>
  )
}
