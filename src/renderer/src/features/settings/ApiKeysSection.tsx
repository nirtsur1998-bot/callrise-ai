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

import { ModelLogo, type ModelBrand, type ProviderMark } from '@renderer/components/ModelLogo'

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
  /**
   * A second, NON-SECRET value this provider needs before it can be called.
   * Only Cloudflare has one: its base URL contains the account id, so a key on
   * its own addresses nothing. Modelled as an extra field on the same card
   * rather than a second card, because it is not a second credential — it is
   * half of one, and splitting it would read as "two providers".
   *
   * Main treats the provider as unconfigured until BOTH are present
   * (providerHasCredentials in ai/registry.ts), so a half-filled card cannot
   * silently produce failing calls.
   */
  secondField?: {
    name: AiKeyName
    label: string
    placeholder: string
    /** One line telling the user where to actually find this value. Required:
     *  a field nobody can fill in is a support ticket with a text box. */
    hint: string
  }
  /** Which mark to draw beside the title. Deliberately a SEPARATE field from
   *  `providerId`: ModelBrand names the company whose mark this is, and the
   *  two only coincide by luck. Omitted where no mark applies (Deepgram is a
   *  transcription service, not one of the model brands). */
  brand?: ModelBrand | { label: string; mark?: ProviderMark }
}

const RETENTION_LABEL: Record<RetentionPosture, string> = {
  trains: 'Trains on your data',
  'no-training': 'No training on API data',
  unknown: 'Unknown — check provider terms'
}

const RETENTION_CLASS: Record<RetentionPosture, string> = {
  trains: 'border-danger/40 bg-danger/10 text-danger',
  'no-training': 'border-positive/30 bg-positive-soft text-positive',
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
    brand: { label: 'Claude', mark: 'claude' },
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
    brand: 'openai',
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
    brand: { label: 'Groq' },
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
    brand: 'openrouter',
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
    brand: 'google',
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
    brand: 'nvidia',
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
    brand: { label: 'Cerebras' },
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
    brand: 'mistral',
    retention: { posture: 'unknown', url: 'https://legal.mistral.ai/terms' }
  },
  {
    name: 'ZAI_API_KEY',
    title: 'Z.ai (GLM)',
    blurb: 'Two GLM models are permanently free — no card, no expiry. China-hosted.',
    getKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    getKeyLabel: 'Get a free Z.ai key',
    placeholder: 'Paste your Z.ai API key',
    providerId: 'zai',
    brand: 'zai',
    retention: { posture: 'no-training', url: 'https://docs.z.ai/legal-agreement/terms-of-use' }
  },
  {
    name: 'HUGGINGFACE_API_KEY',
    title: 'Hugging Face',
    // The free credit really is about ten cents a month. Saying so on the
    // card is the whole point: a provider that looks like the others and
    // then stops working after a day is precisely the "looks real, isn't"
    // defect this milestone exists to remove. Better a small number the
    // reader can judge than a pleasant sentence they find out is wrong.
    blurb: 'Routes to open models like GPT-OSS. Free credit is tiny (~$0.10/month) — good for trying it, not for daily use.',
    getKeyUrl: 'https://huggingface.co/settings/tokens',
    getKeyLabel: 'Get a free Hugging Face token',
    placeholder: 'Paste your Hugging Face access token',
    providerId: 'huggingface',
    // No Simple Icons CC0 mark for Hugging Face in this repo's asset set, so
    // it takes the lettermark — the documented fallback in
    // assets/model-logos/SOURCES.md, not a placeholder to replace later.
    // The lettermark renders label.charAt(0) — a visible 'H', matching the
    // single letters the other fallbacks use — while the full string becomes
    // the aria-label. So this is 'Hugging Face', not 'HF': the eye gets the
    // letter either way, and the screen reader gets the real name.
    brand: { label: 'Hugging Face', mark: 'huggingface' },
    // 'unknown', not 'no-training': HF states it does not store request or
    // response bodies, but the inference runs at whichever downstream
    // provider the router picks, and their terms vary. See the catalog
    // entries for the full reasoning.
    retention: { posture: 'unknown', url: 'https://huggingface.co/docs/inference-providers/security' }
  },
  {
    name: 'CLOUDFLARE_API_KEY',
    title: 'Cloudflare Workers AI',
    blurb:
      'The largest genuinely free allowance here — a daily quota, no card, resets every day. Needs your account ID as well as a key.',
    getKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    getKeyLabel: 'Create a free Workers AI token',
    placeholder: 'Paste your Cloudflare API token',
    providerId: 'cloudflare',
    brand: { label: 'Cloudflare', mark: 'cloudflare' },
    // Verified 2026-08-30 against their own data-usage page, which states
    // Cloudflare does not use Customer Content to train models made available
    // on Workers AI, nor to improve Cloudflare or third-party services.
    retention: {
      posture: 'no-training',
      url: 'https://developers.cloudflare.com/workers-ai/platform/data-usage/'
    },
    secondField: {
      name: 'CLOUDFLARE_ACCOUNT_ID',
      label: 'Account ID',
      placeholder: 'Paste your Cloudflare account ID',
      // The dashboard URL is the most durable place to point at: it does not
      // move when Cloudflare reorganises its navigation, which a named page
      // does. The Workers page is given second as the signposted route.
      hint: 'In your dashboard URL — dash.cloudflare.com/<this long string> — or on Workers & Pages → Overview.'
    }
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
  connected: 'bg-positive',
  'no-key': 'bg-line',
  invalid: 'bg-danger',
  'rate-limited': 'bg-warning'
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

/**
 * The extra non-secret field (Cloudflare's account id). Deliberately plainer
 * than the key input: no show/hide toggle, because there is nothing to hide,
 * and a masking affordance on a value that is not a secret teaches the wrong
 * thing about which of these two values matters.
 */
function SecondFieldRow({
  field,
  status,
  onChanged
}: {
  field: NonNullable<KeyCardConfig['secondField']>
  status: AiKeyStatus | undefined
  onChanged: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(savedTimeout.current), [])

  const save = async (): Promise<void> => {
    const trimmed = value.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await window.api.aiKeys.save(field.name, trimmed)
      setValue('')
      setSaved(true)
      clearTimeout(savedTimeout.current)
      savedTimeout.current = setTimeout(() => setSaved(false), 4000)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-2">
        <label className="text-[12px] font-medium text-muted">{field.label}</label>
        {status?.configured && (
          <span className="flex items-center gap-1 text-[12px] font-medium text-positive">
            <CheckCircle2 className="h-3 w-3" /> Set
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          placeholder={field.placeholder}
          autoComplete="off"
          spellCheck={false}
          className={cn(fieldClass, 'flex-1')}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!value.trim() || busy}
          className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </button>
      </div>
      <p className="mt-1 text-[12px] text-faint">{field.hint}</p>
      {saved && <p className="mt-1 text-[12px] text-positive">Saved.</p>}
    </div>
  )
}

export function KeyCard({
  config,
  status,
  secondStatus,
  onChanged
}: {
  config: KeyCardConfig
  status: AiKeyStatus | undefined
  secondStatus?: AiKeyStatus | undefined
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
          {/* The provider's mark, at the same 18px the model picker uses.
              Reuses <ModelLogo> rather than a second logo component, so the
              two places you meet a provider look like the same product —
              including the lettermark fallback for brands Simple Icons does
              not carry (Groq, Cerebras). See assets/model-logos/SOURCES.md:
              CC0 marks only, never a hand-approximated trademark, and the
              lettermark is the designed contingency rather than a
              placeholder. */}
          {config.brand && <ModelLogo brand={config.brand} size={18} />}
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
            <span className="flex items-center gap-1.5 rounded-lg border border-positive/30 bg-positive-soft px-2.5 py-1 text-xs font-medium text-positive">
              <CheckCircle2 className="h-3.5 w-3.5" /> Configured
              {status.hint ? ` · ${status.hint}` : ''}
            </span>
          )}
        </div>
      </div>
      <p className="mb-3 text-[13px] text-muted">{config.blurb}</p>

      {config.secondField && (
        <SecondFieldRow
          field={config.secondField}
          status={secondStatus}
          onChanged={onChanged}
        />
      )}

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
          className="flex items-center gap-2 rounded-lg bg-accent-fill px-3.5 py-2 text-sm font-medium text-on-accent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
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
        <p className={cn('mt-2 text-[13px]', testResult.ok ? 'text-positive' : 'text-danger')}>
          {testResult.message}
        </p>
      )}
      {savedNotice && (
        <p className="mt-2 text-[13px] text-positive">Saved — takes effect immediately.</p>
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

// Short labels for the compact selector — KEYS' own `title` (e.g. "Gemini
// (Google AI Studio)") is right for the key-entry cards below but too long
// for a segmented control with ten options. Typed Record<AiProviderId, _>
// deliberately: this is the one place in the renderer that MUST name every
// provider, so a new one fails the build here rather than rendering a
// blank-labelled segment nobody can identify.
const PROVIDER_SHORT_LABEL: Record<AiProviderId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  google: 'Gemini',
  nvidia: 'NVIDIA',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  zai: 'Z.ai',
  huggingface: 'Hugging Face',
  cloudflare: 'Cloudflare'
}

/** Bug found by the founder: "Ask the coach" and a few other features
 *  (custom trackers, objection mining, call titles, CRM notes, deal risk)
 *  resolve their model through THIS single setting, not the Model
 *  Assignment page's per-purpose fallback chains — so with the selector
 *  hardcoded to only Claude/ChatGPT, a user who configured a different
 *  provider (Groq, Gemini, ...) saw those features fail with "add your
 *  Claude or ChatGPT key" even though a perfectly good key was already
 *  saved. Every provider is offered here now, matching every key card
 *  below and PROVIDER_REGISTRY — a count is not written down on purpose,
 *  since the last one went stale the moment M31 added two. */
const PROVIDER_OPTIONS = KEYS.filter((k): k is KeyCardConfig & { providerId: AiProviderId } =>
  Boolean(k.providerId)
).map((k) => ({ id: k.providerId, label: PROVIDER_SHORT_LABEL[k.providerId] }))

function ProviderSelector(): React.JSX.Element {
  const { settings, update } = useAppSettings()

  return (
    <Card className="mb-5">
      <h3 className="mb-1 text-sm font-medium">Default text AI provider</h3>
      <p className="mb-3 text-[13px] text-muted">
        Backs any job with no specific model assigned on the{' '}
        <span className="font-medium text-ink">Model Assignment</span> page — coaching feedback,
        summaries, live cues, and &ldquo;Ask the coach&rdquo; — unless you&apos;ve assigned them something
        else. Switching takes effect immediately — make sure the provider&apos;s key below is
        configured first. Set automatically the first time you save a key below; change it here
        any time.
      </p>
      <SegmentedControl
        options={PROVIDER_OPTIONS}
        value={settings.aiProvider}
        onChange={(id) => void update({ aiProvider: id })}
        className="flex-wrap"
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
  // Bumped on every key save/clear so ProviderSelector remounts and re-reads
  // settings from disk — a save can auto-select a provider on the main-process
  // side (see ai-keys.ts's maybeAutoSelectProvider), which ProviderSelector's
  // own useAppSettings() instance has no other way to learn about.
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    void window.api.aiKeys.getStatus().then(setStatus)
  }, [])

  // Only ever called from a KeyCard's onChanged (a save/clear the user just
  // did), never from the mount effect above — bumping refreshNonce
  // synchronously here is fine; doing it directly inside the mount effect
  // would trip the set-state-in-effect rule (this drives the state, not
  // just reacting to a mount-time fetch resolving).
  const refresh = (): void => {
    void window.api.aiKeys.getStatus().then(setStatus)
    setRefreshNonce((n) => n + 1)
  }

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        CallRise AI needs a Deepgram key for live transcription, plus at least one text-AI
        provider&apos;s key below for coaching, summaries, and live cues. Each has its own free or
        pay-as-you-go tier — sign up, copy the key, and paste it below. Assign specific models to
        specific jobs on the <span className="font-medium text-ink">Model Assignment</span> page.
      </p>
      <ProviderSelector key={refreshNonce} />
      {KEYS.map((k) => (
        <KeyCard
          key={k.name}
          config={k}
          status={status?.[k.name]}
          secondStatus={k.secondField ? status?.[k.secondField.name] : undefined}
          onChanged={refresh}
        />
      ))}
    </>
  )
}
