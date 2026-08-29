# The typeface decision — why it isn't Satoshi

**Written 2026-08-29, M31 Stage 4.** The founder authorised downloading Satoshi
from Fontshare *conditionally*: **"check the license terms yourself and tell me
plainly what they permit for a commercial desktop app before you bundle it. If
the license doesn't clearly allow it, STOP."**

**It does not clearly allow it. I stopped. Nothing was downloaded from
Fontshare.**

---

## 1. What we actually need permission to do

Precision matters here, because "can I use this font commercially?" and "can I
do *our* thing?" have different answers.

We ship an Electron desktop app. Bundling a typeface means **placing a copy of
the font file inside `app.asar`, inside an installer, and distributing that
installer to every user.** Every install puts a copy of the font file on
someone else's computer.

That is redistribution of the font file. It is not the same as "using the font
in a design", and it is the specific act the license has to permit.

## 2. What the ITF Free Font License says

Satoshi is published by Indian Type Foundry under the **ITF Free Font License**
(ITF FFL) — a closed-source EULA, not an open-source license. Fontshare also
hosts some fonts under SIL OFL, but Satoshi is not one of them.

The FFL's two relevant halves point in opposite directions for our case:

- **Permits** — free personal and commercial use, unlimited time, "in any
  medium — print, web, mobile, digital, apps, ePub, broadcast, OEM", including
  logos, with no device cap, and embedding in read-only PDFs.
- **Prohibits** — distributing, duplicating, lending, reselling or
  sub-licensing **the files**; uploading them to a public server; bundling them
  into a product being sold; modifying the font.

Read together: "apps" appears in the permission list as a **medium your design
may appear in**, while the restriction list forbids distributing or duplicating
**the font files** — which is precisely what shipping an installer does. Those
two clauses are in genuine tension for a downloadable desktop app in a way they
are not for, say, a website (where the font is served, not handed over) or a
print job (where no font file moves at all).

## 3. Two independent reasons this fails the founder's bar

The bar set was *"clearly allow"*, not *"probably fine"*.

1. **The clauses conflict for our exact case**, as above. A permission that
   requires choosing between two clauses is not a clear permission.
2. **I could not retrieve the authoritative text.** `fontshare.com/licenses/itf-ffl`
   returns only navigation chrome to a fetcher — the license body never
   arrived, across repeated attempts. Everything in §2 is therefore assembled
   from secondhand summaries, **and those summaries contradict each other on
   the single clause that matters**: one states you may "download an offline kit
   and self-host", another states the FFL "restricts redistributing or
   self-hosting the raw font files without permission." I am not willing to put
   a commercial product's font licensing on a disagreement between two blog
   posts.

Either reason alone triggers the stop condition. Both together make it easy.

**The clean path if you want Satoshi specifically:** ITF sells commercial
licenses and answers licensing email. A one-line "may we bundle Satoshi inside
a distributed desktop application?" to them turns this from ambiguous into
written permission. That is a founder action, not mine — it's your company
asking, and the answer should be in your inbox, not my transcript.

## 4. General Sans has the same problem

Worth flagging directly, because it was named as a fallback: **General Sans is
also an ITF font under the same ITF Free Font License.** It is not an
alternative to the problem — it is the same problem with a different name.

Manrope, the other name on the list, *is* clean — see below.

## 5. What shipped instead

Both under **SIL Open Font License 1.1**, which — unlike the FFL — explicitly
permits bundling and redistributing the font files as part of a software
package, with the only real conditions being that the license notice travels
with the font and that you don't sell the font by itself under its own name.
Both packages ship their `LICENSE` file inside `node_modules`, so the notice
travels automatically.

| Role | Face | License | Source |
|---|---|---|---|
| UI / body | **Manrope Variable** | OFL-1.1 | `@fontsource-variable/manrope` |
| Data / mono | **Geist Mono Variable** | OFL-1.1 | `@fontsource-variable/geist-mono` |

**Why Manrope over Plus Jakarta Sans** (the other OFL candidate, which I
installed and rendered in the real app before choosing):

- **Narrower set width.** This is a dense sales tool — the sidebar already
  truncates call titles like "Thomas Investment Update a…". A wider face
  truncates more, on every screen, forever.
- **Cleaner word spacing at heading weight.** Plus Jakarta Sans sets word
  spaces noticeably tight at semibold — "test user" reads close to "testuser"
  in our own greeting. Visible in the 2× comparison capture.
- **Numerals.** The metric tiles ("37", "44", "0m") are a real surface in this
  product, and Manrope's figures are crisper at 24–32px.

Plus Jakarta Sans is arguably *closer to Satoshi's actual feel* — rounder,
warmer, more open. If matching the original identity board matters more than
the density argument, it's a two-minute swap:
`npm i @fontsource-variable/plus-jakarta-sans`, one import in `main.tsx`, one
line in `index.css`. It was removed rather than left installed so we don't ship
144 KB of font nobody renders.

## 6. Why self-hosted rather than Google Fonts

Not a preference — a constraint. The app's CSP is `'self'`-only
(`src/main/index.ts` response header and `src/renderer/index.html` meta tag), so
a `<link>` to `fonts.googleapis.com` would be blocked outright. Separately, a
desktop app should not need a network round-trip to render its own interface.

Vite emits the `.woff2` files as real assets rather than `data:` URIs (they are
far above `assetsInlineLimit`), which is what keeps them inside `'self'` — the
meta CSP has no `font-src` and falls back to `default-src 'self'`, which would
*not* permit `data:` fonts even though the header CSP does.

Full families are bundled, not latin-only subsets: Summary language can render
AI output in Cyrillic, Greek or Vietnamese, and dropping to a system fallback
mid-paragraph is exactly the seam this stage exists to remove. Total cost
~270 KB of woff2.
