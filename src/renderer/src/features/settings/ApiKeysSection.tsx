import { useEffect, useState } from 'react'
import { CheckCircle2, Eye, EyeOff, ExternalLink, Loader2 } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { fieldClass } from '@renderer/components/field'
import { IconButton } from '@renderer/components/IconButton'
import { cn } from '@renderer/lib/cn'

// Derive the key/status shapes straight from the preload bridge so they can
// never drift from what the main process actually returns.
type StatusMap = Awaited<ReturnType<typeof window.api.aiKeys.getStatus>>
type AiKeyName = Parameters<typeof window.api.aiKeys.save>[0]
type AiKeyStatus = StatusMap[AiKeyName]

interface KeyCardConfig {
  name: AiKeyName
  title: string
  blurb: string
  getKeyUrl: string
  getKeyLabel: string
  placeholder: string
}

const KEYS: KeyCardConfig[] = [
  {
    name: 'DEEPGRAM_API_KEY',
    title: 'Deepgram (live transcription)',
    blurb: 'Turns your voice into text in real time during a call.',
    getKeyUrl: 'https://console.deepgram.com/',
    getKeyLabel: 'Get a free Deepgram key',
    placeholder: 'Paste your Deepgram API key'
  },
  {
    name: 'ANTHROPIC_API_KEY',
    title: 'Anthropic (coaching & summaries)',
    blurb: 'Writes call summaries, coaching feedback, and live cues.',
    getKeyUrl: 'https://console.anthropic.com/',
    getKeyLabel: 'Get an Anthropic key',
    placeholder: 'Paste your Anthropic API key'
  }
]

function KeyCard({ config, status, onChanged }: {
  config: KeyCardConfig
  status: AiKeyStatus | undefined
  onChanged: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)

  const save = async (): Promise<void> => {
    if (!value.trim() || busy) return
    setBusy(true)
    try {
      const res = await window.api.aiKeys.save(config.name, value.trim())
      if (res.ok) {
        setValue('')
        setSavedNotice(true)
        onChanged()
        setTimeout(() => setSavedNotice(false), 4000)
      }
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.api.aiKeys.clear(config.name)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{config.title}</h3>
        {status?.configured && (
          <span className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-200">
            <CheckCircle2 className="h-3.5 w-3.5" /> Configured{status.hint ? ` · ${status.hint}` : ''}
          </span>
        )}
      </div>
      <p className="mb-3 text-[13px] text-muted">{config.blurb}</p>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type={showValue ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
            placeholder={config.placeholder}
            autoComplete="off"
            spellCheck={false}
            className={cn(fieldClass, 'pr-9')}
          />
          <IconButton
            icon={showValue ? EyeOff : Eye}
            label={showValue ? 'Hide key' : 'Show key'}
            onClick={() => setShowValue((s) => !s)}
            className="absolute right-1 top-1/2 -translate-y-1/2"
          />
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!value.trim() || busy}
          className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </button>
        {status?.configured && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            Remove
          </button>
        )}
      </div>

      {savedNotice && (
        <p className="mt-2 text-[13px] text-emerald-300">
          Saved — quit and reopen the app for it to take effect.
        </p>
      )}

      <a
        href={config.getKeyUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline"
      >
        {config.getKeyLabel} <ExternalLink className="h-3 w-3" />
      </a>
    </Card>
  )
}

/** Lets each user bring their own Deepgram + Anthropic keys instead of the
 *  app shipping (and billing) one key for every customer. Keys are stored
 *  encrypted on this device only — never sent anywhere but the provider
 *  itself, and never shown back in full once saved. */
export function ApiKeysSection(): React.JSX.Element {
  const [status, setStatus] = useState<StatusMap | null>(null)

  const refresh = (): void => {
    void window.api.aiKeys.getStatus().then(setStatus)
  }

  useEffect(refresh, [])

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        CallRise AI needs a Deepgram key for live transcription and an Anthropic key for coaching
        and summaries. Both have their own free or pay-as-you-go tiers — sign up, copy the key,
        and paste it below.
      </p>
      {KEYS.map((k) => (
        <KeyCard key={k.name} config={k} status={status?.[k.name]} onChanged={refresh} />
      ))}
    </>
  )
}
