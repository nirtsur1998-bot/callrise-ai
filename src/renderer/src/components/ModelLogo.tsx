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
// no entry in Simple Icons as of this milestone (see SOURCES.md) and are
// expected to render via the fallback indefinitely, or until a real source
// exists. The picker must never show a broken image either way.
import { cn } from '@renderer/lib/cn'
import openaiSvg from '../assets/model-logos/openai.svg?raw'
import metaSvg from '../assets/model-logos/meta.svg?raw'
import qwenSvg from '../assets/model-logos/qwen.svg?raw'
import googleSvg from '../assets/model-logos/google.svg?raw'
import deepseekSvg from '../assets/model-logos/deepseek.svg?raw'
import nvidiaSvg from '../assets/model-logos/nvidia.svg?raw'
import mistralSvg from '../assets/model-logos/mistral.svg?raw'
import openrouterSvg from '../assets/model-logos/openrouter.svg?raw'

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

const BRAND_SVG: Partial<Record<ModelBrand, string>> = {
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

const BRAND_LABEL: Record<ModelBrand, string> = {
  meta: 'Meta',
  openai: 'OpenAI',
  qwen: 'Qwen',
  google: 'Google',
  deepseek: 'DeepSeek',
  nvidia: 'NVIDIA',
  zai: 'Z.ai',
  mistral: 'Mistral',
  openrouter: 'OpenRouter'
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
   *  A plain string ALWAYS draws a lettermark, never a mark: per SOURCES.md,
   *  the only marks in this app are CC0 ones from Simple Icons, and a brand
   *  absent from that set gets the designed lettermark rather than a
   *  hand-approximated trademark. */
  brand: ModelBrand | { label: string }
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
  const svg = isNamed ? BRAND_SVG[brand] : undefined
  const label = isNamed ? BRAND_LABEL[brand] : brand.label

  if (svg) {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('inline-flex shrink-0 items-center justify-center text-ink', className)}
        style={{ width: size, height: size }}
        // Safe: `svg` is one of the fixed, bundled, developer-controlled
        // strings in BRAND_SVG above (build-time ?raw imports of files in
        // this repo) — never user input, never fetched at runtime.
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
