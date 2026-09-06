import { Tooltip } from '@renderer/components/Tooltip'
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
/** BUG-146 — the validate bridge now also accepts 'deepgram', which is NOT a
 *  provider id. Deriving AiProviderId straight from it (as this line used to)
 *  silently widened the type that PROVIDER_OPTIONS and PROVIDER_SHORT_LABEL are
 *  built from, i.e. it would have offered Deepgram in the "default text AI
 *  provider" picker — the one outcome the whole `validateAs` split exists to
 *  prevent. The compiler caught it; the subtraction below states the invariant
 *  instead, and `deepgram-is-not-a-provider.test.ts` pins the half TypeScript
 *  cannot see (that 'deepgram' really is absent from PROVIDER_REGISTRY — if it
 *  ever joined, this Exclude would quietly remove a real provider). */
type AiValidateTarget = Parameters<typeof window.api.aiKeys.validate>[0]
type AiProviderId = Exclude<AiValidateTarget, 'deepgram'>

import { ModelLogo, type ModelBrand, type ProviderMark } from '@renderer/components/ModelLogo'

export type RetentionPosture = 'trains' | 'no-training' | 'unknown'

export interface KeyCardConfig {
  name: AiKeyName
  title: string
  blurb: string
  getKeyUrl: string
  getKeyLabel: string
  placeholder: string
  /** Set for every text-AI provider. Also what PROVIDER_OPTIONS is built
   *  from, so it means "selectable as the default text AI provider" — which
   *  is why Deepgram must never have one. */
  providerId?: AiProviderId
  /** BUG-146 — what "Test key" probes, when that is not the provider id.
   *  Deepgram is the only card that needs this: it HAS a real check (see
   *  main/deepgram-key.ts) but must stay out of `providerId` and therefore out
   *  of the default-provider picker. Absent everywhere else, where the provider
   *  id already names the thing to check. */
  validateAs?: 'deepgram'
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
    <Tooltip content="Opens the provider's own data-usage terms">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          'inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-medium hover:underline',
          RETENTION_CLASS[posture]
        )}
      >
        {RETENTION_LABEL[posture]}
      </a>
    </Tooltip>
  )
}

const KEYS: KeyCardConfig[] = [
  {
    name: 'DEEPGRAM_API_KEY',
    title: 'Deepgram (live transcription)',
    blurb: 'Turns your voice into text in real time during a call.',
    getKeyUrl: 'https://console.deepgram.com/',
    getKeyLabel: 'Get a free Deepgram key',
    placeholder: 'Paste your Deepgram API key',
    // BUG-146 — the app's most consequential credential, and until now the
    // only one with no way to check it. NOT `providerId`: that would enrol
    // Deepgram in the default-text-AI-provider picker it can never serve.
    validateAs: 'deepgram'
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
    // Cloudflare's own documented deep link — resolves to the signed-in
    // account and lands on the page that carries BOTH the prefilled
    // "Create a Workers AI API Token" flow and the account id. The generic
    // /profile/api-tokens page makes you assemble the permissions by hand,
    // which is how you end up with a token that authenticates but has no
    // Workers AI access — rejected, with nothing on screen saying why.
    getKeyUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
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
      hint: 'On the same Workers AI page, under "Get Account ID". Also the long string in your dashboard URL, after dash.cloudflare.com/.'
    }
  }
]

type KeyStatusDot = 'connected' | 'no-key' | 'invalid' | 'rate-limited' | 'unchecked'

/**
 * Session-local: the last verdict this session produced for this card, from
 * either "Test key" or the save's own probe (they share one mechanism in main
 * — see probeKey in ai-keys.ts), plus whether a key is saved at all.
 *
 * BUG-146 — 'unchecked' REPLACED the old fall-through to 'connected'.
 *
 * The comment that stood here said a saved-but-now-invalid key "just shows
 * Connected ... same limitation M16 already had". That sentence is cited in
 * ai-keys-comment-drift.test.ts as instance #2 of this repo's comment drift:
 * honest when written, then the hiding place for the bug the founder found by
 * typing `junk` into a card. The limitation it described is now gone rather
 * than re-documented.
 *
 * A stored key with no verdict this session — the state EVERY card is in on a
 * fresh launch, because verdicts are not persisted — now reads "Not checked"
 * instead of "Connected". That is a downgrade in reassurance and an upgrade in
 * truth: presence was never health, and "Connected" is the word that makes
 * someone stop looking for the problem. "Not checked" is one click from an
 * answer, and the click is right there.
 */
// Exported for `api-key-status-dot.test.ts`. This repo cannot assert on
// component render output (BUG-140), so the mapping that decides whether a card
// CORRECTION 2026-09-05: components CAN be render-tested here — see live-header-pieces.render.test.ts (`@vitest-environment happy-dom`, react-dom/client, a `.test.ts` file). The pure/UI split below still stands on its own merits; it is no longer forced.
// says "Connected" or "Key invalid" is tested as the pure function it is — and
// the two call sites below (`title=` and the visible label) both read
// STATUS_DOT_LABEL[deriveStatusDot(...)], so pinning the function pins the text.
export function deriveStatusDot(
  status: AiKeyStatus | undefined,
  testResult: { ok: boolean; message: string } | null
): KeyStatusDot {
  if (testResult) {
    if (testResult.ok) return 'connected'
    return /rate.?limit/i.test(testResult.message) ? 'rate-limited' : 'invalid'
  }
  return status?.configured ? 'unchecked' : 'no-key'
}

/**
 * BUG-148 — the sentence shown when the scheduler has stopped leading with a
 * provider. The founder's framing, kept verbatim because it is the honest one:
 * we are not overriding their choice, we are declining to spend the first
 * attempt of every call on a credential the provider just rejected.
 *
 * Says WHAT happened, WHY, and WHAT clears it. It deliberately does not
 * interrupt: no banner, no modal, no badge on the nav — it sits on the card
 * for the provider it concerns, which is where someone wondering about that
 * provider already is.
 */
export function demotionNotice(demotedSince: number | undefined): string | null {
  if (demotedSince === undefined) return null
  // An ABSOLUTE clock time, not "5 min ago", and the reason is not cosmetic:
  // a relative label needs `Date.now()` at render time, which is an impure
  // call during render (React flags it, and it produces text that silently
  // disagrees with itself between two renders of the same state). Formatting
  // the timestamp we were given depends only on the prop, so the same state
  // always renders the same words.
  const at = new Date(demotedSince).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
  return (
    `Skipped since ${at}: this provider rejected your key on more than one call, ` +
    'so it is no longer tried first. Your default AI provider setting has not changed. ' +
    'Test or re-save a working key to use it first again.'
  )
}

const STATUS_DOT_CLASS: Record<KeyStatusDot, string> = {
  connected: 'bg-positive',
  'no-key': 'bg-line',
  invalid: 'bg-danger',
  'rate-limited': 'bg-warning',
  // Deliberately NOT bg-line: "no key" and "key we haven't checked" are
  // different states and must not render identically. bg-muted is the same
  // neutral dot LiveCallPill already uses for an idle-but-present state.
  unchecked: 'bg-muted'
}

export const STATUS_DOT_LABEL: Record<KeyStatusDot, string> = {
  connected: 'Connected',
  'no-key': 'No key',
  invalid: 'Key invalid',
  'rate-limited': 'Rate limited',
  unchecked: 'Not checked'
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
  // BUG-143 — what the save DID beyond storing the key: either this key became
  // the default provider, or it was declined for that job because it did not
  // validate. Both were previously silent, and the silent version is how the
  // founder ended up with every feature pointed at a rejected Cloudflare token
  // while a working Hugging Face key sat right there.
  const [saveOutcome, setSaveOutcome] = useState<'made-default' | 'unverified' | null>(null)
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
        // BUG-143 — say what happened to the DEFAULT, not just to the key.
        // `autoSelectedProvider` is set only when the default actually moved;
        // `keyValidated === false` means we tried to promote this key and it
        // did not answer, so we left the default alone.
        setSaveOutcome(
          res.autoSelectedProvider ? 'made-default' : res.keyValidated === false ? 'unverified' : null
        )
        // BUG-143 follow-up — THE STATUS DOT MUST NOT SAY "Connected" FOR A KEY
        // THAT DID NOT ANSWER. `deriveStatusDot` reads `status.configured`,
        // which is only `Boolean(process.env[name])` — presence, not health —
        // so a saved-but-rejected key rendered a green "Connected" dot. The
        // founder typed `junk` and got green dot / green tick / "Saved — takes
        // effect immediately", all three false, on the screen where being wrong
        // costs most: someone who reads "Connected" stops looking for the
        // problem.
        //
        // The save now carries the same verdict the "Test key" button produces,
        // so it is fed into the SAME state that button uses. One display path,
        // one meaning, and the provider's own words rather than a generic line.
        //
        // BUG-146 — the SUCCESS case is now recorded too. It used to set null,
        // which meant "no verdict" and fell through to presence; with presence
        // no longer standing in for health, discarding a successful check would
        // show "Not checked" one line under "Saved". Three states, three
        // values: checked-good, checked-bad, and `undefined` = nothing could
        // check it (CLOUDFLARE_ACCOUNT_ID), which stays null and reads
        // "Not checked" honestly.
        setTestResult(
          res.keyValidated === true
            ? { ok: true, message: 'Key works.' }
            : res.keyValidated === false
              ? {
                  ok: false,
                  message: res.validationReason ?? "This key didn't answer when we checked it."
                }
              : null
        )
        onChanged()
        clearTimeout(savedTimeout.current)
        savedTimeout.current = setTimeout(() => {
          setSavedNotice(false)
          setSaveOutcome(null)
        }, 4000)
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

  // BUG-146 — what this card can have checked. Deepgram carries `validateAs`
  // because it has a real probe but deliberately no provider id; every other
  // card is named by its provider id. Derived rather than a second hand-kept
  // field, so the two cannot drift the way AI_KEY_NAMES once drifted from its
  // own union.
  const testTarget = config.validateAs ?? config.providerId

  const testKey = async (): Promise<void> => {
    if (!testTarget || !value.trim() || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.aiKeys.validate(testTarget, value.trim())
      setTestResult(
        res.ok ? { ok: true, message: 'Key works.' } : { ok: false, message: res.reason }
      )
    } finally {
      setTesting(false)
    }
  }

  const statusDot = deriveStatusDot(status, testResult)
  const demotionMessage = demotionNotice(status?.demotedSince)

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
          {testTarget && (
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
          {/* "Key saved", not "Configured". BOTH are true — this badge is
              driven by `status.configured`, which is only "a key is stored" —
              but next to a RED "Key invalid" dot, "Configured" is read as
              "working", and the two badges contradicted each other on screen.
              The logic is correct and stays; only the word changes, because
              the word was doing more work than the value behind it.
              (2026-08-30, founder: "fix the wording, not the logic".) */}
          {status?.configured && (
            <span className="flex items-center gap-1.5 rounded-lg border border-positive/30 bg-positive-soft px-2.5 py-1 text-xs font-medium text-positive">
              <CheckCircle2 className="h-3.5 w-3.5" /> Key saved
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
        {testTarget && (
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
      {/* A provider with two credentials cannot honestly report "your key was
          rejected": a wrong account id fails exactly the same way, because the
          id is in the URL the key authenticates against. Saying "key" alone
          sends someone to regenerate a token that was fine. Only shown on
          failure, and only where a second credential actually exists. */}
      {testResult && !testResult.ok && config.secondField && (
        <p className="mt-1 text-[12px] text-muted">
          Either credential can cause this — a token without Workers AI
          permissions, or a wrong {config.secondField.label}. Check the{' '}
          {config.secondField.label} first: it is the easier of the two to get
          wrong, and it fails identically.
        </p>
      )}
      {/* BUG-148 — findable without hunting, and without interrupting. */}
      {demotionMessage && <p className="mt-2 text-[13px] text-warning">{demotionMessage}</p>}
      {savedNotice && (
        <p className="mt-2 text-[13px] text-positive">Saved — takes effect immediately.</p>
      )}
      {saveOutcome === 'made-default' && (
        <p className="mt-1 text-[13px] text-secondary">
          This is now your default AI provider. You can change that below.
        </p>
      )}
      {saveOutcome === 'unverified' && (
        <p className="mt-1 text-[13px] text-secondary">
          Saved, but this key didn&apos;t answer when we checked it — so we left your default AI
          provider as it was. Use “Test key” to see why.
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
