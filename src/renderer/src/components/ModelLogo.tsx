// M20 — bundled brand marks for the model picker. Never hotlinks a remote
// logo (breaks offline, leaks a request per render) — every SVG below is
// bundled at build time via Vite's `?raw` import (raw string, no new
// dependency needed for an SVGR-style component import — this codebase has
// none configured) and injected inline so `fill="currentColor"` on each file
// picks up the row's text color, staying legible in both light and dark
// theme. See assets/model-logos/SOURCES.md for provenance/licensing of each
// file — all CC0 1.0 (Simple Icons), no vendor press-kit scraping.
//
// The lettermark fallback (a rounded tile with the brand's initial) is not
// a placeholder-until-later for every brand — Groq, Cerebras, and Z.ai have
// no entry in Simple Icons (re-checked 2026-08-30, still 404) and are
// expected to render via the fallback indefinitely, or until a real source
// exists. The picker must never show a broken image either way.
//
// M31 correction: Anthropic/Claude, Hugging Face and Cloudflare DO have CC0
// marks and were rendering as lettermarks anyway — the first two because the
// original pass only ever checked the three brands above, the third because
// it did not exist here yet. Founder spotted it on the API keys page. They
// arrive through PROVIDER_SVG rather than BRAND_SVG, because they are
// PROVIDERS, not model makers: widening ModelBrand would break its documented
// lockstep with main/ai/model-catalog.ts, which is a real constraint and not
// worth spending on a logo.
import { cn } from '@renderer/lib/cn'
import openaiSvg from '../assets/model-logos/openai.svg?raw'
import metaSvg from '../assets/model-logos/meta.svg?raw'
import qwenSvg from '../assets/model-logos/qwen.svg?raw'
import googleSvg from '../assets/model-logos/google.svg?raw'
import deepseekSvg from '../assets/model-logos/deepseek.svg?raw'
import nvidiaSvg from '../assets/model-logos/nvidia.svg?raw'
import mistralSvg from '../assets/model-logos/mistral.svg?raw'
import openrouterSvg from '../assets/model-logos/openrouter.svg?raw'
import claudeSvg from '../assets/model-logos/claude.svg?raw'
import huggingfaceSvg from '../assets/model-logos/huggingface.svg?raw'
import cloudflareSvg from '../assets/model-logos/cloudflare.svg?raw'

// Keep in lockstep with main/ai/model-catalog.ts's ModelBrand — duplicated
// here (not imported) because the renderer never imports main-process code.
export type ModelBrand =
  | 'meta'
  | 'openai'
  | 'qwen'
  | 'google'
  | 'deepseek'
  | 'nvidia'
  | 'zai'
  | 'mistral'
  | 'openrouter'
  | 'anthropic'

const BRAND_SVG: Partial<Record<ModelBrand, string>> = {
  anthropic: claudeSvg,
  openai: openaiSvg,
  meta: metaSvg,
  qwen: qwenSvg,
  google: googleSvg,
  deepseek: deepseekSvg,
  nvidia: nvidiaSvg,
  mistral: mistralSvg,
  openrouter: openrouterSvg
  // 'zai' intentionally absent - see SOURCES.md. Falls through to the
  // lettermark below, exactly the case this fallback exists for.
}

/**
 * Marks for things that are PROVIDERS rather than model makers — the API keys
 * page lists these, the model picker does not. Separate from BRAND_SVG on
 * purpose: ModelBrand is documented as staying in lockstep with the main
 * process's own ModelBrand union, and a provider that ships nobody's models
 * (Cloudflare, Hugging Face) has no business in it.
 *
 * Same provenance rule as everything else here: CC0, Simple Icons, no
 * hand-drawn approximations. See SOURCES.md.
 */
export type ProviderMark = 'claude' | 'huggingface' | 'cloudflare'

const PROVIDER_SVG: Record<ProviderMark, string> = {
  claude: claudeSvg,
  huggingface: huggingfaceSvg,
  cloudflare: cloudflareSvg
}

const BRAND_LABEL: Record<ModelBrand, string> = {
  meta: 'Meta',
  openai: 'OpenAI',
  qwen: 'Qwen',
  google: 'Google',
  deepseek: 'DeepSeek',
  nvidia: 'NVIDIA',
  zai: 'Z.ai',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  // BUG-154 — Anthropic joined ModelBrand when the catalog gained Claude
  // entries. The header note above refuses to widen ModelBrand for things that
  // "are PROVIDERS, not model makers"; Anthropic makes Claude, so it meets
  // that bar rather than bending it, and the CC0 Claude mark already imported
  // for PROVIDER_SVG serves it directly.
  anthropic: 'Claude'
}

export interface ModelLogoProps {
  /** A model/provider brand with a bundled CC0 mark, or a plain name to draw
   *  as a lettermark.
   *
   *  The string escape hatch exists because the API-keys page lists PROVIDERS
   *  (Anthropic, Groq, Cerebras, Deepgram) while `ModelBrand` names MODEL
   *  MAKERS, and the two only partly overlap. Widening ModelBrand instead
   *  would have broken its stated contract — it is kept "in lockstep with
   *  main/ai/model-catalog.ts's ModelBrand", and adding renderer-only members
   *  would quietly end that.
   *
   *  A plain string with no ` mark ` draws a lettermark: per SOURCES.md, the
   *  only marks in this app are CC0 ones from Simple Icons, and a brand absent
   *  from that set gets the designed lettermark rather than a hand-approximated
   *  trademark. Pass ` mark ` when a CC0 provider mark DOES exist — the label is
   *  still required, because it stays the accessible name either way. */
  brand: ModelBrand | { label: string; mark?: ProviderMark }
  /** Square size in px. Defaults to the picker row's 24×24 optical box. */
  size?: number
  className?: string
}

/** A model or provider brand mark, 24×24 by default — falls back to a
 *  lettermark tile (never a broken image) when no bundled SVG exists for
 *  this brand. Identifies the model/provider only — never implies
 *  partnership or endorsement (see SOURCES.md's brand-guidelines note). */
export function ModelLogo({ brand, size = 24, className }: ModelLogoProps): React.JSX.Element {
  const isNamed = typeof brand === 'string'
  const svg = isNamed ? BRAND_SVG[brand] : brand.mark ? PROVIDER_SVG[brand.mark] : undefined
  const label = isNamed ? BRAND_LABEL[brand] : brand.label

  if (svg) {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('inline-flex shrink-0 items-center justify-center text-ink', className)}
        style={{ width: size, height: size }}
        // Safe: `svg` is one of the fixed, bundled, developer-controlled
        // strings in BRAND_SVG or PROVIDER_SVG above (build-time ?raw imports
        // of files in this repo) — never user input, never fetched at runtime.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }

  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md bg-accent-fill font-semibold text-on-accent',
        className
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {label.charAt(0)}
    </span>
  )
}
