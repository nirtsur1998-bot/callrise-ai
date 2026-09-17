import { AudioLines, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import { useVirtualMic } from './useVirtualMic'

// Plain-language text for the error codes virtualmic.ts can return from a
// failed start attempt.
function errorMessage(code: string): string {
  switch (code) {
    case 'microphone access denied':
      return "Couldn't turn on — microphone access was denied. Check System Settings → Privacy & Security → Microphone, then try again."
    case 'noise-cancellation helper not found':
      return "Couldn't turn on — the noise-cancellation engine wasn't found on disk."
    case 'driver not installed':
      return "Couldn't turn on — the audio device isn't installed yet."
    case 'could not launch helper':
      return "Couldn't turn on — the noise-cancellation engine failed to start."
    case 'driver bundle not found':
      return "Couldn't install — the audio device wasn't found on disk."
    case 'install failed':
      return "Couldn't install — something went wrong copying the audio device. Try again."
    case 'uninstall failed':
      return "Couldn't remove the audio device — it's still installed. Try again."
    case 'unsupported-architecture':
      // Belt and braces: the card returns early on an Intel Mac so this should
      // be unreachable from the UI. It exists because virtualmic.ts can return
      // the code to any caller, and a bare code leaking into the interface is
      // exactly the unexplained-failure shape this refusal was added to remove.
      return 'Noise cancellation needs a Mac with Apple silicon (M1 or later). This Mac has an Intel processor.'
    default:
      return `Couldn't turn on (${code}). Try again in a moment.`
  }
}

/** Home section: turn app-managed noise cancellation on/off. When on, a helper
 *  cleans the mic and publishes it as the "Sales OS Microphone" device — which
 *  the user then selects in Zoom/Meet (or here) so the buyer hears clean audio. */
export function NoiseCancellationCard(): React.JSX.Element | null {
  const { status, busy, error, start, stop, installDriver, uninstallDriver } = useVirtualMic()

  // The noise-cancellation engine is a macOS Core Audio driver — it doesn't
  // exist on other platforms (a Windows version is its own future project), so
  // showing this card there would only advertise a dead end.
  if (!isMac) return null

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

  // Intel Mac: the driver and the helper are both arm64-only, so nothing here
  // can work. Say so plainly INSTEAD of rendering the controls.
  //
  // The alternative — showing "Set up" as normal — is the failure this replaces:
  // the install would succeed, the user would type an admin password, and no
  // microphone would ever appear, with nothing anywhere explaining why. Told
  // "not supported yet", they have something to act on; left with a silently
  // missing device, they have a mystery and a support ticket.
  if (!status.architectureSupported) {
    return (
      <Card className="mb-5">
        <div className="mb-2 flex items-center gap-2">
          <AudioLines className="h-4 w-4 text-faint" />
          <h3 className="text-sm font-medium">Noise cancellation</h3>
        </div>
        <p className="text-[13px] leading-relaxed text-faint">
          Not available on this Mac yet. Noise cancellation currently requires Apple silicon (M1 or
          later) — this Mac has an Intel processor. Everything else in CallRise works normally, and
          your microphone is unaffected.
        </p>
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
                : 'bg-accent-fill text-on-accent hover:opacity-90'
            )}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {helperRunning ? 'Turn off' : 'Turn on'}
          </button>
        ) : null}
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-danger/20 bg-danger-soft p-3">
          <p className="flex items-start gap-1.5 text-[13px] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {errorMessage(error)}
          </p>
        </div>
      )}

      {/* Not set up: the driver isn't installed yet. */}
      {!driverInstalled && (
        <div className="rounded-xl border border-line-soft bg-canvas p-3">
          <p className="flex items-start gap-1.5 text-[13px] text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The &ldquo;Sales OS Microphone&rdquo; audio device isn&rsquo;t installed yet.
          </p>
          <p className="mt-1.5 text-[11px] text-faint">
            One-time setup installs a system audio device. macOS will ask for your admin password —
            that part&rsquo;s unavoidable for any app installing a system audio device, but
            there&rsquo;s nothing else to do.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void installDriver()}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-accent-fill px-3 py-1.5 text-[13px] font-medium text-on-accent transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Install
          </button>
        </div>
      )}

      {/* The counterpart to Install, which had none.
          Dragging CallRise to the Trash cannot remove a driver from
          /Library/Audio/Plug-Ins/HAL, so without this the only way off a
          machine was a `sudo rm -rf` the user would have to be told. Kept
          deliberately quiet — small, plain text, no destructive-red styling —
          because it must be findable without competing with Turn on/off.
          Shown only when there is actually something to remove. */}
      {driverInstalled && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-line-soft pt-2.5">
          <p className="text-[11px] text-faint">
            Removes the &ldquo;Sales OS Microphone&rdquo; audio device from this Mac. Noise
            cancellation stops working until you install it again.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void uninstallDriver()}
            className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-faint transition hover:bg-elevated hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            Remove
          </button>
        </div>
      )}

      {/* Driver present but the helper binary is missing (dev edge case). */}
      {driverInstalled && !helperAvailable && (
        <p className="flex items-start gap-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          The noise-cancellation engine couldn&rsquo;t be found on disk.
        </p>
      )}

      {/* Set up + on. */}
      {setUp && on && (
        <div className="rounded-xl border border-positive/20 bg-positive-soft p-3">
          <p className="flex items-center gap-1.5 text-[13px] text-positive">
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
        <p className="flex items-start gap-1.5 text-[11px] text-warning">
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
