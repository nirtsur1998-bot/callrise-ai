import { Mic, Volume2, RefreshCw, Headphones, AlertTriangle } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { IconButton } from '@renderer/components/IconButton'
import { fieldClass } from '@renderer/components/field'
import { cn } from '@renderer/lib/cn'
import { useAudioDevices } from './useAudioDevices'
import { isMac, isWindows } from '@renderer/lib/platform'

function looksLikeHeadphones(label: string): boolean {
  return /head(phone|set)|airpod|buds|earphone/i.test(label)
}

/** Home section: choose which microphone the app records, and see where the
 *  call audio is playing (with a headphones reminder to avoid mic echo). */
export function AudioSourcesCard(): React.JSX.Element {
  const { mics, outputLabel, selectedMicId, chooseMic, refresh } = useAudioDevices()
  const onHeadphones = outputLabel ? looksLikeHeadphones(outputLabel) : false

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Audio sources</h3>
        <IconButton icon={RefreshCw} onClick={refresh} label="Refresh devices" />
      </div>

      {/* Microphone (input) — the one thing we control */}
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <Mic className="h-4 w-4 text-faint" /> Microphone
      </label>
      <select
        value={selectedMicId}
        onChange={(e) => chooseMic(e.target.value)}
        aria-label="Microphone"
        className={cn(fieldClass, 'mt-1.5')}
      >
        <option value="">System default</option>
        {mics.map((m) => (
          <option key={m.deviceId} value={m.deviceId}>
            {m.label}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-[11px] text-faint">
        Applied when you start a call. Pick your headset mic for the cleanest split.
      </p>

      {/* Output — informational only (macOS controls where the call plays) */}
      <div className="mt-4 rounded-xl border border-line-soft bg-canvas p-3">
        <div className="flex items-center gap-2 text-[13px]">
          {onHeadphones ? (
            <Headphones className="h-4 w-4 text-positive" />
          ) : (
            <Volume2 className="h-4 w-4 text-warning" />
          )}
          <span className="text-muted">Call plays through</span>
          <span className="font-medium text-ink">{outputLabel ?? 'Unknown'}</span>
        </div>
        <p
          className={cn(
            'mt-1.5 flex items-start gap-1.5 text-[11px]',
            onHeadphones ? 'text-faint' : 'text-warning'
          )}
        >
          {!onHeadphones && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
          {onHeadphones
            ? 'Good for calls — the other person plays into your ears, so your mic hears only you.'
            : 'Use headphones on calls, or your mic picks up the other person and both sides get double-transcribed.'}
        </p>
        <p className="mt-1.5 text-[11px] text-faint">
          CallRise AI can&rsquo;t change this — set your output in{' '}
          {isMac
            ? 'macOS (menu bar → Sound)'
            : isWindows
              ? 'Windows (Settings → Sound)'
              : 'your system sound settings'}
          .
        </p>
      </div>
    </Card>
  )
}
