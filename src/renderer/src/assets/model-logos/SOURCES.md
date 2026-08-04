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

## Not sourced — lettermark fallback in use

**Groq**, **Cerebras**, and **Z.ai (GLM)** are not present in Simple Icons as
of 2026-07-30 (newer/smaller brands the library hasn't added yet). Rather
than hand-approximate a trademarked mark from memory — which risks being
both inaccurate and a shakier rights position than a CC0-licensed source —
these three render via `<ModelLogo>`'s lettermark fallback (a rounded tile
with the brand's initial in the app's accent color). This is the exact
contingency the fallback was built for, not a placeholder-until-later; if
Simple Icons adds these brands later, drop the fetched SVG in here with the
same `fill="currentColor"` normalization and the component picks it up
automatically — no other code change needed.

## Brand guidelines note

These are identifying marks only — see each component usage: `ModelLogo`
never implies partnership, sponsorship, or endorsement by the trademark
holder. Do not resize, recolor with a second color, or combine these marks
with other logos in a way that could read as a lockup/co-branding.
