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

export type RetentionPosture = 'trains' | 'no-training' | 'unknown'

export interface KeyCardConfig {
  name: AiKeyName
  title: string
  blurb: string
  getKeyUrl: string
  getKeyLabel: string
  placeholder: string
  /** Set for every text-AI provider — Deepgram has no "Test key" flow (it's
   *  transcription, not text completion — a separate, untouched system). */
  providerId?: AiProviderId
  /** Data-retention posture (M20 hard invariant) — omitted only for
   *  Deepgram, which isn't one of the model-picker's text-AI providers. */
  retention?: { posture: RetentionPosture; url: string }
}

const RETENTION_LABEL: Record<RetentionPosture, string> = {
  trains: 'Trains on your data',
  'no-training': 'No training on API data',
  unknown: 'Unknown — check provider terms'
}

const RETENTION_CLASS: Record<RetentionPosture, string> = {
  trains: 'border-danger/40 bg-danger/10 text-danger',
  'no-training': 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  unknown: 'border-line bg-elevated text-muted'
}

function RetentionBadge({ posture, url }: { posture: RetentionPosture; url: string }): React.JSX.Element {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-medium hover:underline',
        RETENTION_CLASS[posture]
      )}
      title="Opens the provider's own data-usage terms"
    >
      {RETENTION_LABEL[posture]}
    </a>
  )
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
    providerId: 'anthropic',
    retention: { posture: 'no-training', url: 'https://www.anthropic.com/legal/commercial-terms' }
  },
  {
    name: 'OPENAI_API_KEY',
    title: 'ChatGPT (OpenAI)',
    blurb: 'An alternative to Claude for summaries, coaching feedback, and live cues.',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    getKeyLabel: 'Get an OpenAI key',
    placeholder: 'Paste your OpenAI API key',
    providerId: 'openai',
    retention: { posture: 'no-training', url: 'https://openai.com/policies/api-data-usage-policies' }
  },
  {
    name: 'GROQ_API_KEY',
    title: 'Groq',
    blurb: 'Very fast free-tier Llama, GPT-OSS, and Qwen models — the default for live coaching cues.',
    getKeyUrl: 'https://console.groq.com/keys',
    getKeyLabel: 'Get a free Groq key',
    placeholder: 'Paste your Groq API key',
    providerId: 'groq',
    retention: { posture: 'unknown', url: 'https://groq.com/privacy-policy/' }
  },
  {
    name: 'OPENROUTER_API_KEY',
    title: 'OpenRouter',
    blurb: 'A router across many free models, including an auto-picker that survives one getting delisted.',
    getKeyUrl: 'https://openrouter.ai/keys',
    getKeyLabel: 'Get a free OpenRouter key',
    placeholder: 'Paste your OpenRouter API key',
    providerId: 'openrouter',
    retention: { posture: 'unknown', url: 'https://openrouter.ai/docs/features/privacy-and-logging' }
  },
  {
    name: 'GOOGLE_AI_API_KEY',
    title: 'Gemini (Google AI Studio)',
    blurb: 'Strong free-tier quality, good for structured post-call summaries.',
    getKeyUrl: 'https://aistudio.google.com/apikey',
    getKeyLabel: 'Get a free Google AI Studio key',
    placeholder: 'Paste your Google AI Studio API key',
    providerId: 'google',
    retention: { posture: 'trains', url: 'https://ai.google.dev/gemini-api/terms' }
  },
  {
    name: 'NVIDIA_API_KEY',
    title: 'NVIDIA NIM',
    blurb: 'Free-tier access to DeepSeek V3.2 and GLM-5.2 for analytical, long-form work.',
    getKeyUrl: 'https://build.nvidia.com/',
    getKeyLabel: 'Get a free NVIDIA NIM key',
    placeholder: 'Paste your NVIDIA API key',
    providerId: 'nvidia',
    retention: { posture: 'unknown', url: 'https://build.nvidia.com/terms' }
  },
  {
    name: 'CEREBRAS_API_KEY',
    title: 'Cerebras',
    blurb: 'Very fast inference — the automatic fallback for GPT-OSS 120B if Groq is unavailable.',
    getKeyUrl: 'https://cloud.cerebras.ai/',
    getKeyLabel: 'Get a free Cerebras key',
    placeholder: 'Paste your Cerebras API key',
    providerId: 'cerebras',
    retention: { posture: 'no-training', url: 'https://www.cerebras.ai/terms-of-service' }
  },
  {
    name: 'MISTRAL_API_KEY',
    title: 'Mistral',
    blurb: 'Reliable, low-refusal, European-hosted — a good fit for EU-sensitive calls.',
    getKeyUrl: 'https://console.mistral.ai/api-keys',
    getKeyLabel: 'Get a free Mistral key',
    placeholder: 'Paste your Mistral API key',
    providerId: 'mistral',
    retention: { posture: 'unknown', url: 'https://legal.mistral.ai/terms' }
  }
]

type KeyStatusDot = 'connected' | 'no-key' | 'invalid' | 'rate-limited'

/** Session-local: derived from the last "Test key" result plus whether a
 *  key is saved at all. There's no persisted "this key is currently
 *  rejected" state — a saved-but-now-invalid key just shows "Connected"
 *  until the next Test click or a real AI call fails, same limitation M16
 *  already had. */
function deriveStatusDot(
  status: AiKeyStatus | undefined,
  testResult: { ok: boolean; message: string } | null
): KeyStatusDot {
  if (testResult && !testResult.ok) {
    return /rate.?limit/i.test(testResult.message) ? 'rate-limited' : 'invalid'
  }
  return status?.configured ? 'connected' : 'no-key'
}

const STATUS_DOT_CLASS: Record<KeyStatusDot, string> = {
  connected: 'bg-emerald-400',
  'no-key': 'bg-line',
  invalid: 'bg-danger',
  'rate-limited': 'bg-amber-400'
}

const STATUS_DOT_LABEL: Record<KeyStatusDot, string> = {
  connected: 'Connected',
  'no-key': 'No key',
  invalid: 'Key invalid',
  'rate-limited': 'Rate limited'
}

/** Reused by the onboarding flow's ApiKey step (single-card, Deepgram-only)
 *  so both places share the exact same save/test/clear logic. */
export const DEEPGRAM_KEY_CONFIG: KeyCardConfig = KEYS[0]

export function KeyCard({
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

  const statusDot = deriveStatusDot(status, testResult)

  return (
    <Card className="mb-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{config.title}</h3>
          {config.providerId && (
            <span
              className="flex items-center gap-1.5 text-xs font-medium text-muted"
              title={STATUS_DOT_LABEL[statusDot]}
            >
              <span className={cn('h-2 w-2 rounded-full', STATUS_DOT_CLASS[statusDot])} />
              {STATUS_DOT_LABEL[statusDot]}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {config.retention && (
            <RetentionBadge posture={config.retention.posture} url={config.retention.url} />
          )}
          {status?.configured && (
            <span className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-200">
              <CheckCircle2 className="h-3.5 w-3.5" /> Configured
              {status.hint ? ` · ${status.hint}` : ''}
            </span>
          )}
        </div>
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

/** M16's original default: which of the two ORIGINAL providers backs any job
 *  that has no explicit model assigned on the new Model Assignment page.
 *  Left exactly as-is (Claude/ChatGPT only) — the 6 free-tier providers
 *  below participate only through per-job model assignment, never through
 *  this global switch, so an existing install that never opens the new page
 *  sees zero behavior change. */
function ProviderSelector(): React.JSX.Element {
  const { settings, update } = useAppSettings()

  return (
    <Card className="mb-5">
      <h3 className="mb-1 text-sm font-medium">Default text AI provider</h3>
      <p className="mb-3 text-[13px] text-muted">
        Backs any job with no specific model assigned on the{' '}
        <span className="font-medium text-ink">Model Assignment</span> page — coaching feedback,
        summaries, and live cues, unless you&apos;ve assigned them something else. Switching takes
        effect immediately — make sure the provider&apos;s key below is configured first.
      </p>
      <SegmentedControl
        options={PROVIDER_OPTIONS}
        value={settings.aiProvider}
        onChange={(id) => void update({ aiProvider: id })}
      />
    </Card>
  )
}

/** Lets each user bring their own Deepgram + text-AI provider keys instead
 *  of the app shipping (and billing) one key for every customer. Keys are
 *  stored encrypted on this device only — never sent anywhere but the
 *  provider itself, and never shown back in full once saved. M20 widened
 *  this from the original Claude/ChatGPT pair to 8 text-AI providers —
 *  which model each job (live cues, summaries, scorecards, tasks, prep
 *  briefs) actually uses is on the separate Model Assignment page, since
 *  picking from a 10-model catalog is a bigger UI than fits here. */
export function ApiKeysSection(): React.JSX.Element {
  const [status, setStatus] = useState<StatusMap | null>(null)

  const refresh = (): void => {
    void window.api.aiKeys.getStatus().then(setStatus)
  }

  useEffect(refresh, [])

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        CallRise AI needs a Deepgram key for live transcription, plus at least one text-AI
        provider&apos;s key below for coaching, summaries, and live cues. Each has its own free or
        pay-as-you-go tier — sign up, copy the key, and paste it below. Assign specific models to
        specific jobs on the <span className="font-medium text-ink">Model Assignment</span> page.
      </p>
      <ProviderSelector />
      {KEYS.map((k) => (
        <KeyCard key={k.name} config={k} status={status?.[k.name]} onChanged={refresh} />
      ))}
    </>
  )
}
