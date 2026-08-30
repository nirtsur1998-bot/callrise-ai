# Model/provider logo sources

All SVGs in this folder are sourced from **[Simple Icons](https://simpleicons.org/)**
(`simple-icons` npm package), a curated library of brand icons distributed
under the **CC0 1.0 Universal** license (public domain — no attribution
legally required, though credited here for transparency). This was chosen
over scraping each vendor's own press-kit page directly, since Simple Icons
already normalizes every mark to a clean, single-path, monochrome SVG on a
24×24 viewBox — exactly the optical bounding box this picker needs — and its
license is unambiguous or every file in this folder.

Fetched 2026-07-30 from `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/<slug>.svg`,
then had `fill="currentColor"` added to the root `<svg>` so each mark inherits
the picker row's text color (monochrome-safe in both light and dark theme,
per the milestone's requirement) — no other modification to the path data.

| File | Brand | Simple Icons slug | License |
|---|---|---|---|
| `openai.svg` | OpenAI (GPT-OSS) | `openai` | CC0 1.0 |
| `meta.svg` | Meta (Llama) | `meta` | CC0 1.0 |
| `qwen.svg` | Qwen / Alibaba | `qwen` | CC0 1.0 |
| `google.svg` | Google (Gemini) | `google` | CC0 1.0 |
| `deepseek.svg` | DeepSeek | `deepseek` | CC0 1.0 |
| `nvidia.svg` | NVIDIA (Nemotron) | `nvidia` | CC0 1.0 |
| `mistral.svg` | Mistral | `mistralai` | CC0 1.0 |
| `openrouter.svg` | OpenRouter | `openrouter` | CC0 1.0 |
| `claude.svg` | Claude / Anthropic | `claude` | CC0 1.0 |
| `huggingface.svg` | Hugging Face | `huggingface` | CC0 1.0 |
| `cloudflare.svg` | Cloudflare (Workers AI) | `cloudflare` | CC0 1.0 |

## Not sourced — lettermark fallback in use

**Groq**, **Cerebras**, and **Z.ai (GLM)** are not present in Simple Icons.
Re-checked 2026-08-30 — all three still 404 on the CDN.

**Correction, 2026-08-30 (M31).** The original pass checked only these three,
so **Claude/Anthropic** and **Hugging Face** rendered as lettermarks despite
having had CC0 marks available the whole time — the founder spotted it on the
API keys page. The lesson is the cheap one: *the fallback firing is not
evidence that no mark exists*, it is evidence that none is bundled. When a
brand is added here, re-run the check for every brand currently on the
lettermark, not just the new one. The bottom three rows of the table above
came from that re-check.

Groq, Cerebras and Z.ai keep the lettermark, and that remains a decision
rather than a gap. Hand-approximating a trademarked mark from memory would be
both less accurate and a shakier rights position than a CC0-licensed source,
so these three render via `<ModelLogo>`'s lettermark fallback (a rounded tile
with the brand's initial in the app's accent color). This is the exact
contingency the fallback was built for, not a placeholder-until-later; if
Simple Icons adds these brands later, drop the fetched SVG in here with the
same normalization and the component picks it up automatically.

**Normalization, exactly:** append `fill="currentColor" width="100%"
height="100%"` to the opening `<svg>` tag, changing nothing else. The width
and height matter — an otherwise-correct file without them renders at the
wrong size, which is how the first attempt at the three 2026-08-30 marks went
in. Compare a new file against an existing one before committing it.

**Where each mark is wired.** Claude, Hugging Face and Cloudflare are
PROVIDERS rather than model makers, so they go through `ModelLogo`'s
`PROVIDER_SVG` map (passed as a `{ label, mark }` brand) rather than
`BRAND_SVG`. `ModelBrand` is documented as staying in lockstep with the main
process's own union in `ai/model-catalog.ts`, and widening it to carry a
renderer-only provider would quietly end that — not a trade worth making for
a logo.

## Brand guidelines note

These are identifying marks only — see each component usage: `ModelLogo`
never implies partnership, sponsorship, or endorsement by the trademark
holder. Do not resize, recolor with a second color, or combine these marks
with other logos in a way that could read as a lockup/co-branding.
