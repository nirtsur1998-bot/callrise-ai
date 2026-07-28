import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Eye, EyeOff, ExternalLink, Loader2, FlaskConical } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { fieldClass } from '@renderer/components/field'
import { IconButton } from '@renderer/components/IconButton'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { cn } from '@renderer/lib/cn'
import { useAppSettings } from './useAppSettings'

// Derive the key/status shapes straight from the preload bridge so they can
// never drift from what the main process actually returns.
type StatusMap = Awaited<ReturnType<typeof window.api.aiKeys.getStatus>>
type AiKeyName = Parameters<typeof window.api.aiKeys.save>[0]
type AiKeyStatus = StatusMap[AiKeyName]
type AiProviderId = Parameters<typeof window.api.aiKeys.validate>[0]

interface KeyCardConfig {
  name: AiKeyName
  title: string
  blurb: string
  getKeyUrl: string
  getKeyLabel: string
  placeholder: string
  /** Set only for the two text-AI providers — Deepgram has no "Test key" flow. */
  providerId?: AiProviderId
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
    title: 'Claude (Anthropic)',
    blurb: 'Writes call summaries, coaching feedback, and live cues.',
    getKeyUrl: 'https://console.anthropic.com/',
    getKeyLabel: 'Get an Anthropic key',
    placeholder: 'Paste your Anthropic API key',
    providerId: 'anthropic'
  },
  {
    name: 'OPENAI_API_KEY',
    title: 'ChatGPT (OpenAI)',
    blurb: 'An alternative to Claude for summaries, coaching feedback, and live cues.',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    getKeyLabel: 'Get an OpenAI key',
    placeholder: 'Paste your OpenAI API key',
    providerId: 'openai'
  }
]

function KeyCard({
  config,
  status,
  onChanged
}: {
  config: KeyCardConfig
  status: AiKeyStatus | undefined
  onChanged: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Same auto-clearing "Saved" pattern as CrmSection/PersonalizationSection/
  // AccountSection, including the cleanup those already have: without it, a
  // save right before navigating away from Settings fires setSavedNotice on
  // an unmounted card after the 4s timer outlives it.
  const savedTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(savedTimeout.current), [])

  const save = async (): Promise<void> => {
    if (!value.trim() || busy) return
    setBusy(true)
    try {
      const res = await window.api.aiKeys.save(config.name, value.trim())
      if (res.ok) {
        setValue('')
        setSavedNotice(true)
        setTestResult(null)
        onChanged()
        clearTimeout(savedTimeout.current)
        savedTimeout.current = setTimeout(() => setSavedNotice(false), 4000)
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
      setTestResult(null)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const testKey = async (): Promise<void> => {
    if (!config.providerId || !value.trim() || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.aiKeys.validate(config.providerId, value.trim())
      setTestResult(
        res.ok ? { ok: true, message: 'Key works.' } : { ok: false, message: res.reason }
      )
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card className="mb-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{config.title}</h3>
        {status?.configured && (
          <span className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-200">
            <CheckCircle2 className="h-3.5 w-3.5" /> Configured
            {status.hint ? ` · ${status.hint}` : ''}
          </span>
        )}
      </div>
      <p className="mb-3 text-[13px] text-muted">{config.blurb}</p>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type={showValue ? 'text' : 'password'}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setTestResult(null)
            }}
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
        {config.providerId && (
          <button
            type="button"
            onClick={() => void testKey()}
            disabled={!value.trim() || testing}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FlaskConical className="h-4 w-4" />
            )}
            Test key
          </button>
        )}
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

      {testResult && (
        <p className={cn('mt-2 text-[13px]', testResult.ok ? 'text-emerald-300' : 'text-danger')}>
          {testResult.message}
        </p>
      )}
      {savedNotice && (
        <p className="mt-2 text-[13px] text-emerald-300">Saved — takes effect immediately.</p>
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

const PROVIDER_OPTIONS = [
  { id: 'anthropic' as const, label: 'Claude' },
  { id: 'openai' as const, label: 'ChatGPT' }
]

/** Which text-AI provider is active — coaching, summaries, tasks, deal-risk,
 *  and live cues all switch together; Deepgram (transcription) is separate
 *  and unaffected by this choice. */
function ProviderSelector(): React.JSX.Element {
  const { settings, update } = useAppSettings()

  return (
    <Card className="mb-5">
      <h3 className="mb-1 text-sm font-medium">Text AI provider</h3>
      <p className="mb-3 text-[13px] text-muted">
        Which AI writes your coaching feedback, summaries, and live cues. Switching takes effect
        immediately — make sure the provider&apos;s key below is configured first.
      </p>
      <SegmentedControl
        options={PROVIDER_OPTIONS}
        value={settings.aiProvider}
        onChange={(id) => void update({ aiProvider: id })}
      />
    </Card>
  )
}

/** Lets each user bring their own Deepgram + Claude/ChatGPT keys instead of
 *  the app shipping (and billing) one key for every customer. Keys are
 *  stored encrypted on this device only — never sent anywhere but the
 *  provider itself, and never shown back in full once saved. */
export function ApiKeysSection(): React.JSX.Element {
  const [status, setStatus] = useState<StatusMap | null>(null)

  const refresh = (): void => {
    void window.api.aiKeys.getStatus().then(setStatus)
  }

  useEffect(refresh, [])

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        CallRise AI needs a Deepgram key for live transcription, and either a Claude or ChatGPT key
        for coaching and summaries. Each has its own free or pay-as-you-go tier — sign up, copy the
        key, and paste it below.
      </p>
      <ProviderSelector />
      {KEYS.map((k) => (
        <KeyCard key={k.name} config={k} status={status?.[k.name]} onChanged={refresh} />
      ))}
    </>
  )
}
