import { useState } from 'react'
import { AudioLines, Loader2, AlertTriangle, CheckCircle2, FileDown } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { cn } from '@renderer/lib/cn'
import { isWindows } from '@renderer/lib/platform'
import type { DenoiseStrength } from '@renderer/features/settings/prefs'
import { useTier1 } from './useTier1'

const STRENGTH_LEVELS: { id: DenoiseStrength; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

const STRENGTH_COPY: Record<DenoiseStrength, string> = {
  low: 'Gentle. Takes the edge off steady noise while keeping the room sounding natural.',
  medium: 'Balanced. Removes most background noise without touching your voice.',
  high: 'Strongest. Removes the most background noise — typing, fans, traffic, people talking nearby.'
}

/**
 * Windows settings card for Tier 1 — driver-free noise cancellation for
 * CallRise's own call audio.
 *
 * A NEW, Windows-specific component rather than a branch inside
 * NoiseCancellationCard.tsx: that component has no clean per-platform split
 * to hook into (one `if (!isMac) return null` guard, then everything below
 * it is coupled to useVirtualMic — the macOS Core Audio driver hook). Adding
 * Tier 1 there would mean interleaving two unrelated engines' state machines
 * in one function. This file, and useTier1.ts, are the whole of the new
 * surface area; NoiseCancellationCard.tsx is untouched by this work — diff
 * it to confirm, don't take that on faith.
 *
 * WHY THIS CANNOT BE A LIVE START/STOP TOGGLE LIKE THE MAC CARD. macOS's
 * Tier 2 helper is a persistent system service — flipping its switch has an
 * actual process to start or stop right then. Tier 1 has no standalone
 * existence: recorder.ts spawns it per call, with the mic name THAT call
 * resolved. There is nothing for this card to start or stop outside a live
 * call, so the toggle here is a PREFERENCE (see getTier1Enabled's doc
 * comment) — flipping it takes effect on the next call, not immediately.
 * The copy below says so plainly rather than implying an instant switch.
 */
/** Standalone card below the main one: collect logs + audio state into a
 *  support zip. Its own component so its state (exporting/result) can't
 *  tangle with the toggle's. */
export function Tier1DiagnosticsCard(): React.JSX.Element | null {
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  if (!isWindows) return null

  const doExport = async (): Promise<void> => {
    setExporting(true)
    setResult(null)
    try {
      // Labels only — the names the user already sees in mic dropdowns.
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
      const { getTier1Enabled, getDenoiseStrength } = await import(
        '@renderer/features/settings/prefs'
      )
      const res = await window.api.tier1.exportDiagnostics({
        deviceLabels: devices.filter((d) => d.kind === 'audioinput').map((d) => d.label),
        tier1Enabled: getTier1Enabled(),
        denoiseStrength: getDenoiseStrength()
      })
      if (res.ok && res.path) setResult(`Saved to ${res.path}`)
      else if (!res.canceled) setResult(res.error ? `Export failed: ${res.error}` : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card className="mb-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Export diagnostics</h3>
          <p className="mt-1 text-[12px] text-faint">
            Collects the noise-cancellation logs and this PC&rsquo;s audio device state into a
            single zip you can attach to a support email. No call audio, recordings or
            transcripts are included.
          </p>
        </div>
        <button
          type="button"
          disabled={exporting}
          onClick={() => void doExport()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-elevated disabled:opacity-60"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
          Export
        </button>
      </div>
      {result && <p className="mt-2 text-[11px] text-faint">{result}</p>}
    </Card>
  )
}

export function Tier1SettingsCard(): React.JSX.Element | null {
  const { status, enabled, setEnabled, strength, setStrength, uiState } = useTier1()

  // Tier 1 is Windows-only — the engine is a Windows binary (kern_bridge.exe)
  // with no macOS equivalent (that's NoiseCancellationCard/Tier 2 instead).
  if (!isWindows) return null

  // Loading the very first status — same pattern as NoiseCancellationCard's
  // own `status === null` branch, not a new state, just no data yet.
  if (status === null) {
    return (
      <Card className="mb-5">
        <div className="flex items-center gap-2 text-[13px] text-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking noise cancellation…
        </div>
      </Card>
    )
  }

  const on = uiState !== 'unavailable' && uiState !== 'off'

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AudioLines className={cn('h-4 w-4', on ? 'text-accent' : 'text-faint')} />
          <h3 className="text-sm font-medium">Noise cancellation</h3>
        </div>

        {uiState !== 'unavailable' && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition',
              enabled
                ? 'border border-line bg-surface text-ink hover:bg-elevated'
                : 'bg-accent text-white hover:opacity-90'
            )}
          >
            {enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      {uiState === 'unavailable' && (
        <p className="flex items-start gap-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          The noise-cancellation engine couldn&rsquo;t be found on this install.
        </p>
      )}

      {uiState === 'off' && (
        <p className="text-[11px] text-faint">
          Off. Turn it on to clean your microphone on your next call — no extra device to
          install, no driver required.
        </p>
      )}

      {uiState === 'starting' && (
        <p className="flex items-center gap-1.5 text-[13px] text-faint">
          {status.engineRunning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
            </>
          ) : (
            'On — will start cleaning your microphone when your next call begins.'
          )}
        </p>
      )}

      {uiState === 'active' && (
        <div className="rounded-xl border border-positive/20 bg-positive-soft p-3">
          <p className="flex items-center gap-1.5 text-[13px] text-positive">
            <CheckCircle2 className="h-3.5 w-3.5" /> On — your voice is being cleaned.
          </p>
        </div>
      )}

      {/* A REAL error state, not folded into 'on' or 'off' — the model failed
       *  to load, so the pipe is carrying unprocessed audio. This is
       *  strictly worse than turning the feature off (raw audio still gets
       *  the OS's own echo cancellation; this passthrough path bypasses it),
       *  so it has to look different from "working", not just quieter. */}
      {uiState === 'model-missing' && (
        <div className="rounded-xl border border-warning/20 bg-canvas p-3">
          <p className="flex items-start gap-1.5 text-[13px] text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            On, but the noise-cancellation model wasn&rsquo;t found — your audio is passing
            through unprocessed right now.
          </p>
        </div>
      )}

      {/* Strength. Shown whenever the engine exists (even switched off, so a
       *  user can set it up before opting in). Takes effect on the NEXT call,
       *  same read-at-call-start contract as the toggle itself. */}
      {uiState !== 'unavailable' && (
        <div className="mt-4 border-t border-line-soft pt-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-[13px] font-medium">How much noise to remove</h4>
            <SegmentedControl options={STRENGTH_LEVELS} value={strength} onChange={setStrength} />
          </div>
          <p className="mt-1.5 text-[11px] text-faint">{STRENGTH_COPY[strength]}</p>
        </div>
      )}
    </Card>
  )
}
