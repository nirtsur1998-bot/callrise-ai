# M31 — design research (source documents)

**Both rounds pasted verbatim by the founder, 2026-08-30.** They were produced
before the M31 brief was written, using Claude with Fable 5.

Read the caveats at the end of each round before citing a number. Several
figures come from onboarding-tool vendors and design agencies with a
commercial interest; the research itself flags which.

---

## Why this file exists

Both research passes lived only in the founder's chat history. That was found
on 2026-08-30, when a proposal was asked to be "grounded in the research, not
invented" and the research could not be located in `docs/`, the Obsidian
vault's `07-Reference` / `06-Ideas` / `02-Architecture`, or anywhere else
reachable.

The consequence was the point: **every session after the one that read them
was reasoning from a paraphrase of a paraphrase.** Decisions were being
attributed to "the research" with no way to check the attribution. Same
species as the lettermark policy (taxonomy 51) — a claim whose evidence has
decayed while the claim keeps being repeated — except here the evidence had
never been written down at all.

---

# ROUND 1 — UX/UI Overhaul Research Milestone

## TL;DR

* The two problems the founder named are the same problem. "Feels boring/like a shell" and "even I only understand ~50% of the features" are both symptoms of a feature-dense app with no information architecture, no progressive disclosure, and no distinctive visual system — the exact "kitchen sink UX" anti-pattern that plagues Salesforce, Notion, and Gong. Fix the structure first (navigation, discoverability, empty states, a Cmd+K command palette), then layer on personality (typography, motion, dark-mode craft, one signature accent color). Doing visual polish first would just be lipstick on the shell.
* The single highest-leverage build is a command palette (Cmd+K) plus redesigned empty states, because they solve discoverability and signal premium quality at once. Competitors' real users are already complaining that Gong is "overwhelming," Fireflies "cluttered," and that they "only use a fraction" of what they pay for — CallRise can win by making its depth discoverable rather than hidden.
* This is very feasible via Claude Code, using shadcn/ui + Radix + Tailwind (with the `cmdk` library), Figma's Dev Mode MCP server, and Anthropic's free first-party `frontend-design` skill. Sequence it as: (1) design system + tokens, (2) navigation/IA + command palette, (3) empty states + contextual onboarding, (4) visual identity pass, (5) motion. Do it behind a feature flag, screen-by-screen, never as a big-bang rewrite.

## Key Findings

1. Discoverability and "boring" are two faces of one root cause: no progressive disclosure and no IA. Feature-dense pro tools that feel "premium" (Linear, Raycast, Superhuman) don't have fewer features — they stage them. The fix is structural, not cosmetic.
2. A Cmd+K command palette is the single most cost-effective pattern for CallRise. It makes every one of the 15+ features reachable by typing, teaches keyboard shortcuts inline, and is the #1 signal of a "power-user" premium tool. It's ~a weekend of engineering with the `cmdk` library.
3. Traditional product tours mostly fail. Nearly 70% of users skip traditional linear tours, and completion collapses as tours get longer; static tooltips are dismissed within seconds. The winning pattern is contextual, just-in-time guidance triggered by user action, plus empty states that double as onboarding, plus a persistent "what's new" surface — not a big welcome-modal tour.
4. Competitors' real users are actively complaining about exactly the problems CallRise wants to avoid — overwhelm, clutter, unused features, notification fatigue, visible bots. These complaints are CallRise's opening.
5. The "Linear/Raycast/Vercel aesthetic" is not a color scheme — it's restraint + one signature accent + bold typography + real product density shown through one repeated component + spring-physics motion + dark-first surfaces. Copying the surface (dark + gradient) produces a "photocopy."
6. The tooling for an AI-assisted redesign through Claude Code is mature as of 2025-2026: shadcn/ui component ownership model, Figma's Dev Mode MCP server (public beta June 4, 2025), Anthropic's `frontend-design` skill, and design-verification subagent workflows.
7. Navigation for 15+ features should be grouped (5-7 top-level items max), collapsible, and search-first — with the command palette as the fast path and the sidebar as the browsable map. "If you need more than 5-7 top-level items, you have an IA problem, not a design one."

## Details

### 1. Feature Discoverability & Onboarding

Progressive disclosure is the core principle. It was introduced by Jakob Nielsen, co-founder of the Nielsen Norman Group, in 1995; NN/g's own definition (Nielsen, 2006) is that progressive disclosure "defers advanced or rarely used features to a secondary screen, making applications easier to learn and less error-prone," with reported task-completion-time reductions of 20–40%. It means showing the core action first and revealing secondary/advanced features only when contextually relevant. NN/g recommends a maximum of 2 disclosure levels for any single interaction, and a 3-layer framework across the whole journey (orientation → contextual → power-user). Notion, Linear, and Figma all default to simplified views and surface advanced config only on user trigger. The risk is over-hiding: if users can't find a feature when they need it, the threshold is set wrong — so track "feature search" and "help request" rates per feature to calibrate.

Product tours largely fail — design for just-in-time discovery instead. Research findings:

* Nearly 70% of users skip traditional, linear product tours, per Chameleon's Benchmark Report 2025 (an analysis of 15 million product-tour interactions). Chameleon's dataset also shows completion collapses with length: 4-step tours peak at 74% completion while 7+ step tours fall to 16%.
* 76.3% of static tooltips are dismissed within 3 seconds, and 78% of users abandon traditional product tours by step three (SaaSFactor, citing Pendo data).
* Users forced through lengthy tours churn at similar rates to users who skip tours entirely — tour completion alone doesn't predict retention. Timing (contextual trigger) matters more than copy or polish.
* Behavior-triggered contextual guidance achieves 2.5× higher engagement (58.7% vs 23.7%) and improves feature adoption 2.9× (42.6% vs 14.7%) over traditional tours (SaaSFactor's contextual-onboarding analysis); Pendo CPO Jennifer Agee notes that "traditional product tours created an illusion of comprehensiveness."
* The classic failure mode ("feature tour fatigue"): "Customers see 15 features, remember none, and open a support ticket asking where to start." This is precisely CallRise's stated problem.

Patterns that actually work for a feature-dense app like CallRise:

* Command palette (Cmd+K) — the highest-leverage discoverability tool (see §6). It's "an amazing training tool for learning keyboard shortcuts" because it shows the shortcut next to every action. Superhuman's palette teaches the shortcut "for next time."
* Empty states as onboarding real estate (see below).
* Onboarding checklists with 3-5 activation actions and a progress indicator — each item opening one core feature. Keep tours (if any) to ≤5 steps, user-initiated, with a visible skip and a re-entry path from a help menu.
* Contextual coachmarks fired on the action, not on page load. A short tooltip sequence beats a modal in dense apps because a modal "breaks the user's spatial memory."
* A persistent "What's New" surface (see §3) so features shipped fast don't vanish into a "feature graveyard."
* Activation-event thinking: define the single action that correlates with retention (for CallRise, likely "first coached call reviewed" or "first objection saved to the library") and remove every obstacle between signup and that first win. "A good onboarding flow does not explain everything. It focuses on one meaningful action."

Empty states are a design goldmine, not a 404. NN/g: empty states let you "communicate system status, increase learnability, and deliver direct pathways for key tasks." Named examples:

* Notion fills the first-run empty state with editable demo content that doubles as an onboarding checklist — no downside if the user messes it up.
* Dropbox replaced "This folder is empty" with a large drag-and-drop target, a one-line explanation, and a friendly illustration.
* Slack uses playful illustrations and never leaves search-empty screens blank.
* For CallRise: every feature's first-run state (empty coaching scorecard, empty objection library, empty deal list, empty Rise chat) should teach what the feature is, show one seeded example, and offer a single primary action. This directly attacks the "50% of features are invisible" problem because the feature explains itself the first time you land on it.

Locked/upgrade states are also empty states — frame them as an invitation ("here's what you'd unlock"), not a punishment. Spotify's pre-limit warning is the model; a hard paywall that "feels like a trap" is the anti-pattern.

### 2. Competitor UX Complaints — Real User Voice

These are the actual words of frustrated users of CallRise's competitors. Sourcing caveat: most are from G2/Capterra/AWS Marketplace review pages; a few were surfaced via competitor-run aggregator blogs (flagged), which have an incentive to highlight negatives and should be verified against the original review before public use. Dates were frequently not exposed in the review snippets.

Gong — "overwhelming," cluttered, hard to navigate, underused:

* "One downside of Gong is that it can feel a bit overwhelming at times. With so many insights, metrics, and notifications, it's not always clear what to focus on first. The signal is there, but you have to work a bit to separate it from the noise." — Verified Reviewer, G2
* "The interface can feel overwhelming at first, especially for new users, because of the volume of data and features… filtering or finding specific calls can sometimes be unintuitive… smoother navigation and simpler onboarding would make it even better." — Verified Reviewer, G2
* "UI can be somewhat cluttered, getting to the exact place you want could be done a bit easier." — Sr. Solutions Engineer, Capterra
* "It is super clunky, hard to find information you need. there is 'conversations' and 'engage' and they don't link…" — Verified user, Capterra
* "First, the platform can be a bit overwhelming for new users due to its rich set of features and data points. It requires some time to fully understand and utilize all the capabilities effectively…" — AWS Marketplace external review
* "There's so much in Gong, that we don't use everything." — Gong G2 review (via Oliv.ai aggregator; verify)
* Review titled "The tool that you didn't know you didn't need" calls Gong "too complicated, and not intuitive at all." (via Sybill aggregator; verify)

Fireflies / Otter — clutter, visible bot, notification fatigue:

* "The most annoying thing is it will send chats to all people… people are being pulled into a chat room to see that Fireflies is recording… The chat feature is disruptive." — Verified Reviewer, G2
* "I don't like that… the bot is asking permission to join the meetings… you see that this is like this person's note takers from five places taking notes… which is not really looking nice." — Verified Reviewer, G2
* "The UI can also feel a bit cluttered when managing a large number of recordings and notes." — Communications Executive, Capterra
* Otter's post-signup dashboard: users are "bombarded with different information and customization options… This can make it look a bit cluttered." (competitor review; directional)
* Independent aggregator description of Fireflies' visible bot: trying to remove it is "like trying to remove a deer tick" because it defaults to joining every calendar event.

Krisp — the bloat lesson (directly relevant to CallRise's multi-feature strategy): Krisp shipped a calendar/meeting-assistant on top of its noise-cancellation core, and long-time users revolted:

* "I paid for Krisp Noise Cancellation - now I have a calendar app?… For me, this is unnecessary bloatware. It loads at startup and requires me to manually close it every time Windows starts… I purchased Krisp for its noise cancellation, nothing more." — AppSumo reviewer, Mar 2025
* Lesson for CallRise: adding features users didn't ask for, turned on by default, without a way to hide them, reads as bloatware even when the feature is good. Every CallRise module should be discoverable but not forced; power comes from opt-in depth, not default clutter.

Salesforce — the cautionary tale of complexity:

* "The UI and UX of this CRM platform look and feel like they are still in the 90s… The interface is cluttered with an abundance of features, buttons, and fields, making it difficult to navigate and use effectively without extensive training."
* "One of the most common complaints about Salesforce is the complexity of navigating the platform. Many users need help understanding the user interface and finding the needed features."

The theme across all competitors: the products aren't bad — they're deep and undiscoverable. CallRise's stated problem is the industry's problem. That's the opportunity.

### 3. Cross-Industry UX Lessons — Feature Bloat / "Kitchen Sink" Apps

The "kitchen sink" anti-pattern, named from "everything but the kitchen sink," is when the full capability of the product is presented at all times, creating cognitive overload. Canonical examples: LinkedIn's original desktop feed, early Salesforce, classic Microsoft Word toolbars. The documented structural causes ("anti-patterns") include: scope creep, the feature factory (measuring output not outcomes), kitchen-sink UX, competitor-parity paranoia, no sunsetting discipline, configuration overload, and "CEO pet features." The fix is progressive disclosure and task-oriented design.

"Navigation is the canary." A widely-cited feature-bloat maxim: "When your solution to complexity is 'we added search,' you have bloat… if users cannot find your features without a search bar, the feature hierarchy is broken." This is a crucial nuance for CallRise: a command palette is necessary but not sufficient — it must sit on top of a coherent nav hierarchy, not paper over a broken one.

Notion's discoverability struggle is the closest analog to CallRise's founder problem — real users:

* "One year after I started using Notion, I was still finding out about features that I didn't know existed before (e.g. the word count function)."
* "Notion's vast features can make it daunting for newcomers – users often spend more time learning and configuring than actually getting work done." One user: "Notion is definitely overkill for simple note-taking."
* "New users often find themselves staring at a blank page without any guidance." (This is why Notion leans so hard on templates and seeded empty states.)

The modern bloat accelerant is AI-cheap feature production. Userpilot's CEO Yazan Sehwail: "As producing and building features become a lot cheaper, instead of… one or two features [a quarter], now you're releasing 7, 8, 9." CallRise "grew feature-rich very quickly" precisely because building got cheap — which makes discoverability discipline the binding constraint, not build velocity.

The turnaround pattern: strip visible features on main screens, standardize the UI across modules, and adopt progressive disclosure. The remedy every case study converges on is the same: fewer things visible by default, clear hierarchy, and just-in-time depth.

### 4. Visual Design — Fixing "Feels Boring / Like a Shell"

Why generic SaaS dashboards feel like shells: every item carries the same visual weight, there's no signature color, default sans-serif fonts, no motion, and empty states left blank. The eye has "nowhere to land."

What actually makes Linear/Raycast/Arc/Superhuman feel premium (concrete, named elements):

* One signature accent color ("one-color ownership"). Linear owns purple, Raycast owns red-orange, Cursor owns cyan. This single-hue ownership is "a key brand differentiator in a category where everything else is converging." CallRise should pick and own one accent (tied to the "Rise" brand) and use it sparingly to guide the eye.
* Restraint in dark mode. Linear's dark UI uses "near-black surfaces, muted borders, and a single accent color — proof that great dark design is mostly about contrast and hierarchy, not decoration." Use dark-gray (not pure black) surfaces, elevation via 1px borders/subtle shadows, and 2-3 accent highlights max. PostHog and Supabase are cited references for keeping analytics-dense dark UIs legible.
* Bolder/distinctive typography. Designers explicitly recommend "moving beyond standard sans-serif fonts to bolder weights or distinctive typefaces" to differentiate from "generic sans-serif defaults." Vercel's custom open-source Geist Sans is the reference. Establish a 3-level type hierarchy (display, body, mono).
* Density shown through ONE repeated component. Raycast "shows dozens of features without feeling crowded" via "uniform card components, generous spacing, and a single-color illustration system." For CallRise: pick one card pattern and repeat it across coaching, deals, objections, tasks — depth without visual noise.
* Spring-physics motion, not linear tweens. The 2025-2026 standard is spring physics (Framer Motion `whileHover`/`whileTap`, spring transitions) because "linear motion feels robotic; spring physics feels human." Motion is communication (feedback, orientation, perceived speed via skeleton loaders), not decoration. Respect `prefers-reduced-motion`.
* Empty states with personality (see §1) — a documented "design opportunity," not a blank screen.

Data-dense screen craft (for CallRise's dashboards, scorecards, deal intelligence):

* Top-left = most critical metric/status (F/Z-pattern scanning).
* Whitespace on an 8px grid does more than borders to separate zones.
* 3-5 semantic colors only; tune green/red for dark surfaces (e.g. `#22C55E` / `#EF4444`, not saturated primaries) and always add a second non-color cue (arrow, +/–) for colorblind users.
* Card hierarchy by brightness: summary cards one surface-step above the page; tables on the page surface. "The eye finds totals first because they are literally brighter."
* Sparklines over full mini-charts inside cards; alerts that "don't shout" (muted left border, slightly lifted surface — not a filled red background).

The critical warning: "Everyone in AI wants the Linear/Vercel/Raycast look. It is not a colour scheme you can copy." Teams that just "add a dark theme and a subtle gradient… end up with something that feels like a photocopy." The distinctiveness comes from point of view and restraint, sweating small details — not from cloning surface treatments. Pick an aesthetic camp (techno-futurist dark vs. editorial) and commit; SaaS design in 2026 has "split into two dominant aesthetics… both are winning, but picking one is non-negotiable."

### 5. Practical Tooling for an AI-Assisted Redesign via Claude Code

Component foundation: shadcn/ui + Radix + Tailwind. This is the dominant 2025-2026 stack and the right choice for CallRise:

* shadcn/ui is not an npm dependency — you copy component source into your repo, so "you own the code" and can theme deeply (crucial for a distinctive, non-generic look). It's built on Radix primitives (accessibility, keyboard nav, focus management handled) and Tailwind.
* It ships pre-composed "Blocks" (dashboards, sidebar layouts, auth flows) and pulls in focused libraries: `cmdk` for the command palette, Embla (carousel), Vaul (drawer), Sonner (toasts), Recharts (charts).
* Theming propagates through CSS custom properties / OKLCH tokens — swap a handful of variables and every component follows. This is how you re-skin the whole app from "shell" to distinctive without rewriting components.

Command palette specifics: use `cmdk` (Vercel's library, used by Linear, Vercel, Raycast, Sourcegraph) or shadcn's `Command`. Key it by stable IDs (so analytics/recents survive renames), let features register their commands as they mount, support nested/sub-pages (Raycast-style), and show keyboard hints inline. A small "⌘K" chip in the header teaches its existence. Bind the global listener at the document level and `preventDefault` so it doesn't collide with browser/OS shortcuts.

Figma ↔ Claude Code:

* Figma's Dev Mode MCP server launched in public beta June 4, 2025 ("Introducing our Dev Mode MCP server"); it exposes three tools — code, images, and variable definitions — and supports Claude Code, VS Code, Cursor, and Windsurf. It lets Claude Code read design context (components, variables, layout, tokens) and generate design-informed code, and (Claude Code–only) write back to the Figma canvas via `generate_figma_design`.
* Recommended setup is the Figma plugin, which bundles MCP settings and Agent Skills for common workflows.
* Known limitations to set expectations: it's stronger at generating new components than making "surgical updates" to existing code; multi-frame flows need frame-by-frame conversion; exported Figma layers "don't carry code logic," so each handoff loses business logic/state. Treat it as an exploration/scaffolding accelerator, not a lossless round-trip.

Anthropic's first-party `frontend-design` Claude Code skill: it had 796,950 installs as of August 25, 2026 (skills.sh registry, via Skillselion) — the third most-installed skill overall. It's a ~50-line `SKILL.md` that runs before Claude writes UI code and forces an aesthetic-direction plan; per Anthropic's plugin listing it "intentionally avoids common patterns like generic system fonts, predictable purple gradients, and cookie-cutter components." It directly targets CallRise's "generic/boring" problem. Caveat: it's tuned for expressive marketing/landing pages and is weaker on "dense product UI" (data tables, settings, dashboards), which "live or die on information density [and] state coverage (loading, empty, error)." So give Claude concrete references for the dense app screens rather than relying on the skill alone.

Design-verification subagent pattern (documented, working): teams run a `design-verification` Claude Code subagent that "continuously validat[es] that all React components matched the original Figma designs," plus a `compliance-checker` that enforces the workflow in `CLAUDE.md` and makes Claude iterate until issues are fixed. Encode your locked decisions in `CLAUDE.md` (chosen fonts + banned generic ones, one dominant color + accent as CSS vars, 8px spacing, forbidden patterns like purple gradients / three-card heroes, shadcn/ui as the foundation, and "screenshot and compare after UI changes").

Higher-level option: Claude Design (claude.ai/design + Claude Mac app) is positioned as a "closed-loop" front end to the Claude Code pipeline — a prototype one tool reads natively into production code — vs. Figma (open-loop handoff) and v0 (half-loop; components live in v0's sandbox, not your codebase/design system).

### 6. Navigation & Information Architecture for 15+ Features

CallRise's feature list — live transcription, AI coaching, deal intelligence, noise cancellation, Rise (Sales Brain chat), CRM, calendar, tasks, coaching scorecards, objection library — is well past the threshold where a flat sidebar breaks down.

Rules from the research:

* Cap top-level nav at 5-7 items. "If you need more than that, you have an information-architecture problem, not a design one." Group CallRise's 15+ features under a handful of parents (e.g. Calls [transcription, recordings], Coaching [scorecards, objection library, AI coaching], Pipeline [deals, CRM], Plan [calendar, tasks], Rise [the AI assistant], plus Settings).
* Three-level visual hierarchy: primary sections most prominent (larger ~15-16px, bolder weight, clear active state), secondary items lighter, utility items smallest.
* Collapsible, grouped sidebar with section headers that expand/collapse; chevrons signal expandability; icons + labels (not icons alone); hovering a collapsed sidebar reveals tooltips. Sidebars take ~15% of the workspace expanded and should collapse to reclaim space for power users.
* Search-first as the fast path, not the only path. The command palette is the "type-to-anywhere" layer on top of a browsable, well-grouped sidebar (the map). Both are needed — remember "navigation is the canary": don't use search to hide a broken hierarchy.
* Active-state + routing hygiene: highlight the active item (including nested parent+child), and render the sidebar as a server/cached component so it doesn't unmount/reflow on navigation.
* Role/permission-aware nav: if managers vs. reps see different items, plan conditional rendering up front. (Chase's mobile banking flows are cited for keeping parent-child groupings visible so the nav "teaches structure instead of forcing recall.")

Recommended CallRise access model: (1) a grouped, collapsible sidebar as the browsable map; (2) a global Cmd+K command palette as the fast path that also teaches shortcuts and surfaces features by name; (3) contextual entry points (empty states, coachmarks) that route users into features they haven't discovered.

## Recommendations

Sequence the overhaul in five stages, behind a feature flag, screen-by-screen — never a big-bang rewrite. A big-bang redesign of a working, revenue-generating app is the #1 way to break it and alienate existing users (see Krisp's forced-calendar backlash and Salesforce's module inconsistency). Ship the design system first, then re-skin and restructure surface by surface.

Stage 0 — Audit & decide (before any code). Inventory all 15+ features; for each, define its primary action, its activation event, and its first-run empty state. Pick ONE signature accent color and a display/body/mono type trio. Choose one aesthetic camp (recommend techno-futurist dark-first, matching the power-user sales audience). Write these decisions into `CLAUDE.md` as locked constraints. Benchmark to change course: if you can't group the features into ≤7 top-level buckets, the IA needs rework before design starts.

Stage 1 — Design system + tokens. Stand up shadcn/ui + Radix + Tailwind with CSS-variable/OKLCH tokens so the whole app re-themes from a handful of variables. Install the `frontend-design` skill and set up the Figma Dev Mode MCP server. This is the foundation that lets every later stage move fast.

Stage 2 — Navigation/IA + command palette (highest leverage). Regroup the sidebar into ≤7 collapsible, labeled groups with a 3-level hierarchy. Ship the `cmdk` Cmd+K palette with a visible "⌘K" chip, inline shortcut hints, feature-registered commands, and nested pages. This stage alone should measurably move the "features discovered per user" metric.

Stage 3 — Empty states + contextual onboarding. Redesign every feature's first-run state to teach + seed + offer one action (Notion/Dropbox model). Add a persistent "What's New" surface (Linear-style changelog: one headline, one visual, one line of why-it-matters per entry). Add ≤5-step, user-initiated, skippable checklists for the 2-3 core activation flows. Replace any big welcome-modal tour with just-in-time coachmarks fired on action. Frame locked/upgrade states as invitations.

Stage 4 — Visual identity pass. Apply the signature color, bold typography, one-repeated-card density model, dark-mode surface hierarchy, and data-dense screen craft (brightness hierarchy, tuned semantic colors, sparklines, quiet alerts). Use a `design-verification` subagent to keep implementation matched to Figma references.

Stage 5 — Motion. Add spring-physics micro-interactions (hover/tap feedback, state transitions, skeleton loaders for perceived speed), respecting `prefers-reduced-motion`. Motion last, so it enhances a solid structure rather than decorating a shell.

Metrics/thresholds that should change the plan:

* Track feature-discovery rate (distinct features used per active user), command-palette adoption, empty-state → first-action conversion, and activation-event completion. If palette adoption is low, make the ⌘K chip more prominent and mention it once in onboarding.
* Track "help request / feature search" rate per feature to calibrate progressive-disclosure thresholds — high search for a feature means it's hidden too deep.
* Keep any onboarding checklist to ≤4 steps: Chameleon's data shows completion falls from ~74% at 4 steps to ~16% at 7+ steps, so if a flow has drop-off, cut steps before rewriting copy.
* Watch support tickets asking "where is X / can it do Y" — these should fall as discoverability improves.

Things a non-technical founder should insist on:

* Don't force new features on by default (Krisp lesson). Discoverable ≠ mandatory.
* Don't let "we added search" substitute for fixing the nav hierarchy (bloat canary).
* Don't ship a 15-feature welcome tour — it's the exact "feature tour fatigue" failure (78% abandon by step three). Favor empty states + Cmd+K + just-in-time cues.
* Set expectations on Figma MCP: great for new screens/exploration, weaker at surgical edits to existing code and lossy across handoffs.
* Preserve existing users' muscle memory: feature-flag the redesign, offer opt-in, and communicate changes with a small modal + hotspots (as Slack did in its 2020 redesign) rather than silently moving everything.

## Caveats

* Source quality: Many competitor user quotes come from G2/Capterra/AWS Marketplace review pages; a subset were surfaced via competitor-run aggregator blogs (Oliv.ai, Sybill, etc.) that have an incentive to highlight negatives — these are flagged in §2 and should be verified against the original review before public/marketing use. Review dates were frequently not exposed in snippets. Chorus.ai verbatim UI complaints were thin; the strongest Chorus UI criticisms come from analyst/blog summaries, not named user quotes.
* Vendor-published statistics (e.g., specific onboarding conversion lifts, tour-completion and tooltip-dismissal rates, adoption percentages) come from onboarding-tool vendors (Userpilot, Chameleon, Pendo/Amplitude reports cited secondhand) and design agencies with a commercial interest; treat the direction as reliable and the precise figures as indicative, not gospel. The `frontend-design` install count (796,950 as of Aug 25, 2026) is from a third-party skills registry, not an official Anthropic figure.
* Nimitai is an early-stage competitor (REN AI Technologies, founded 2025, private beta, $149/seat/mo) with essentially no independent review corpus yet, so no real user-voice UX complaints were available for it; its feature set (real-time co-pilot, objection detection, scorecards, CRM sync) closely mirrors CallRise's and is included for positioning only.
* Fast-moving tooling: Figma MCP, the `frontend-design` skill, and Claude Design are all 2025-late-2025 releases; capabilities and limitations are evolving and should be re-checked at build time.
* This research informs a design and engineering milestone; it does not assess CallRise's actual current codebase, which will determine real refactor cost and constraints (Electron version, state management, existing component debt).

---

# ROUND 2 — Visual/UI Craft & Recent Launch Lessons

## TL;DR

* "Competently modern" is now a trap. The "Linear look" (near-black dark mode, Inter, one violet-to-blue accent, keyboard-first minimalism) has been copied so widely it now reads as generic "AI slop," so CallRise should build a deliberate, ownable visual identity — one distinctive accent color, one non-default typeface, and a genuinely premium AI "thinking" language — rather than defaulting to the safe statistical median that AI code tools and templates produce.
* The direct competitor category proves the opening. Gong and Salesforce are consistently panned as "cluttered/overwhelming/dated," and Avoma (the closest functional analog) as "slow/dated," while Granola (rebranded July 2026, now valued at $1.5B) and Fathom (9.7 G2 ease-of-use) are the design benchmarks. CallRise should target Fathom-level clarity + Granola-level distinctiveness — with the sales depth neither fully delivers.
* On craft: dark-first, monochrome + one restrained accent (accent ≤~5% of screen); non-default type (Geist/Satoshi/General Sans over Inter, plus a mono for data); borders and background-elevation over heavy shadows; subtle/purposeful motion (never bouncy onboarding); and streaming/"stream-of-thought" AI states. Heavy glassmorphism and neumorphism are now dated liabilities — Apple's Liquid Glass accessibility backlash is the cautionary tale.

## Key Findings

### 1. Recent launches — what worked and what flopped

Granola — the direct-category winner and the single most instructive case. Granola was rebranded in July 2026 by London agency Ragged Edge. It deliberately rejected "AI slop": a hand-drawn, intentionally imperfect "G" logo; a custom "Granola Script" typeface built with type foundry NaN from co-founder Sam Stephenson's actual handwriting; Quadrant slab-serif for display paired with Melange as the grotesque UI font; and an acid-lime accent (#b5c832) explicitly chosen to stand apart from the bright RGB/purple hues that dominate AI branding. Ragged Edge co-founder Max Ottignon summarized the strategy: "The temptation in AI is to look like everyone else because the market is moving so quickly." Creative director Jessica Bong-Woon added the identity is "specifically designed to feel slightly imperfect and unmistakably human, an antidote to the overly sleek and impersonal identities that dominate the category." The result: the identity trended on X on launch day, drove Granola's highest-ever daily downloads, and (per Ramp) made it the world's second fastest-growing software brand the following month. Granola then raised a $125M Series C at a $1.5B valuation, announced March 25, 2026, led by Danny Rimer at Index Ventures with Kleiner Perkins (Mamoon Hamid) — a 6x jump from its $250M Series B and bringing total funding to $192M; Bloomberg reported the round followed a quarter of 250% revenue growth. This is direct proof that anti-generic, "human" design wins in exactly CallRise's category.

Apple Liquid Glass (WWDC, June 2025) — the cautionary tale. Apple's translucent redesign across iOS/iPadOS/macOS drew heavy criticism for legibility, contrast, and cognitive load; AppleVis reported it "had a significant negative impact on the user experience for many" low-vision users, and Apple's visual-accessibility grade fell. Apple walked it back repeatedly: "Reduce Transparency," a "Tinted" control in the iOS 26.1 beta, and a "Reduce Bright Effects" toggle in iOS 26.4 beta. Ars Technica described the material as adding "zero information while adding constant motion." Lesson: heavy glass/blur is a legibility risk — especially for a data-dense professional app.

Perplexity (Nov 2025) — a model-downgrade "chip icon" scandal plus sudden, unannounced usage caps triggered cancellations. GPT-5 (Aug 2025) — backlash for removing older models (4o) with no opt-out; Sam Altman reinstated 4o within days ("ok, we hear you all on 4o"). Both reinforce: for an AI product, transparency about what the model is doing is itself a feature, and never remove the familiar option abruptly.

Redesign-backlash pattern (avoid the big-bang). Discord (March 2025), Netflix (2025), KakaoTalk (Sept 2025, its biggest redesign in 15 years), and Fitbit/Google Health (2026) all triggered revolts by moving familiar things at once. The extreme case: Sonos's May 2024 app redesign wiped ~$500M in market value; CEO Patrick Spence stepped down January 13, 2025 (replaced by interim CEO Tom Conrad), with Fast Company noting the redesign preceded an ~8% YoY revenue drop and layoffs of roughly 100 employees. Lesson: for a feature-dense existing app, stage the rollout, explain the rationale, and offer a revert/opt-in.

"Generic AI startup design" is now a named, mocked phenomenon. The "AI purple problem" / "purple gradient blob" is widely ridiculed. Tailwind's creator Adam Wathan posted on X on August 7, 2025 (1M+ views): "I'd like to formally apologize for making every button in Tailwind UI `bg-indigo-500` five years ago, leading to every AI generated UI on earth also being indigo." The mechanism is well documented: LLM code tools regress to the statistical median of their training data — Inter + an indigo/purple gradient + three rounded cards + a centered hero with one CTA. As one agency put it, "generic is worse than ugly because it makes your product forgettable, and forgettable is fatal for a startup." Explicitly avoid this template.

### 2. Next-generation visual specifics for professional desktop apps (2026)

Color. Best-in-class = a monochrome ramp (near-black background, a few gray surface steps) + one accent hue used in small doses — "a good dark mode is in effect mono." Neon/high-saturation accents should cover no more than ~2% of screen. Differentiate on the choice of accent: Vercel = mono + single accent; Figma = bold multi-color; Arc = playful; Linear = violet-blue gradient; Granola = warm acid-lime. Defaulting to SaaS blue (#2563EB/#3B82F6) is now "the riskiest choice you can make." Design dark-first, then derive light — professional teams now treat the dark theme as the primary surface.

Gradients. Overdone as hero decoration and the "AI orb," but subtle functional gradients (button depth, faint surface shifts) remain fine. The cliché to avoid is the glowing purple blob behind the hero.

Buttons & interactive elements. Radius is soft but restrained — typically ~8–12px rounded-square for in-app controls, with `rounded-full` pills reserved for marketing CTAs. Elevation via subtle 1px border + slight background shift rather than heavy drop shadows. Hover = a small `translateY(-1 to -2px)` with a slightly stronger border/shadow; visible focus states for accessibility. Neumorphism is effectively dead (affordance/accessibility problems — buttons blur into the background). Glassmorphism: use sparingly, only for overlays on capable devices, and never stack blur on blur.

Typography. Inter has become "invisible" from overuse: per SaaS Landing Page's catalogue of 500+ fonts, Inter appears on 182 sites — the next most popular (Graphik) on just 21, and Inter recorded 414 billion Google Fonts accesses in the 12 months ending May 2025, up 57% year-on-year. Winning alternatives: Geist (Vercel — AI/dev feel), Satoshi (editorial-geometric), General Sans, Manrope, Plus Jakarta Sans; a mono (e.g., Geist Mono) for data/numbers. Leaders increasingly go custom (Figma, Vercel/Geist, Wise Sans with NaN). Recommendation: a distinctive-but-legible UI sans + a mono for dense data (transcripts, deal metrics, scorecards).

Cards/surfaces/elevation. 2026 thinking favors borders + background-color difference for hierarchy over big shadows. "Intentional incompleteness" — schematic, grid-forward, mono-inspired, control-panel-like layouts — is a rising, distinctive direction (Tubik). Linear keeps high density readable through consistent spacing rhythm and progressive disclosure, not decoration.

Motion. Table stakes: optimistic UI, skeleton states, smooth state transitions, subtle hover feedback. Overdone/annoying: bouncy, over-animated onboarding; motion for motion's sake; anything that harms vestibular users. The rule designers converge on: motion should be "purposeful movement that guides the user," not flashy gimmicks — "the punctuation marks of a digital sentence."

AI-specific UI (directly relevant to Rise + live coaching). Streaming token-by-token text is the baseline expectation ("a response that waits until completion feels broken"); show an immediate indicator during the time-to-first-token gap (a blinking cursor or "thinking…" state); always provide a prominent stop button; and adopt the "stream of thought" pattern — show plan → execution → evidence, with collapsible reasoning — as ChatGPT, Perplexity, and Claude do. Done well, this reads as premium and trustworthy ("watching text appear token by token creates a sense of transparency"), which matters most for enterprise/sales trust.

### 3. AI meeting/sales assistant category specifically

Gong & Salesforce = cluttered/overwhelming/dated — the strongest consensus in the whole category, and CallRise's clearest opening. Representative verified quotes:

* Gong (G2): "The interface can feel overwhelming at first, especially for new users, because of the volume of data and features… filtering or finding specific calls can sometimes be unintuitive." And: "so many insights, metrics, and notifications, it's not always clear what to focus on first. The signal is there, but you have to work a bit to separate it from the noise." (Note: Gong's call-review player is still praised as clean — the clutter critique is about dashboards/navigation/data density.)
* Salesforce (Capterra, Oct/Nov 2024): "The UI is a bit dated." / "overwhelming, as there was so much going on at all times." (G2, Oct 2025): "a robust platform, but it can feel overwhelming… The interface isn't always intuitive."

Fathom = the positive design benchmark. It holds a 9.7 Ease of Use score across ~6,447 G2 reviews (vs. category peers ~8.7–9.3), plus 9.6 Meets Requirements and 9.7 Quality of Support, and a 5.0/5 overall rating. Users: "The UI is clean and easy to use, and the overall experience feels smooth and intuitive." But it is critiqued as "not very sales specific" — the exact gap CallRise can own (Fathom-clean UI + real sales/deal depth). Fathom raised a $17M Series A (Sept 2024).

Granola = the aspirational design/UX leader ("best of breed"): minimalist, bot-free, on-device, praised for intuitive design and clean structured summaries; validated by its $1.5B valuation.

Avoma (closest functional analog: notetaker + revenue intelligence) is dinged for a "busy front end and a lag in page loads… sadly disappointing and feels somewhat dated," and "the interface is a little slow, making it difficult to navigate" — a direct competitor whose visual weakness CallRise can exploit. Otter = "clean but often cluttered" dashboards.

Category funding/launch signals (well-funded, moving toward sales/deal intelligence — CallRise's turf): Granola $43M Series B (May 2025) → $125M Series C at $1.5B (March 2026); Read.ai $50M Series B (Oct 2024, $450M valuation); Fireflies reached a ~$1B valuation via a 2025 tender offer (not a priced round) and launched an AI Sales Suite in July 2026 (CRM autofill, deal intelligence, real-time Sales Assist); Fathom $17M Series A (Sept 2024) with fast ARR growth.

### 4. Differentiation strategy — beyond the "Linear look"

The "linear-ification" of SaaS is itself now a recognized cliché: "Open any new SaaS product launched in the last two years. There is a 50/50 chance it looks like Linear." Copying it no longer differentiates. The forward move, per multiple designers, is taste as the moat: "a distinctive typographic system, a restrained and specific colour story, and real opinions about layout beat any amount of gradient," and "the fastest way to stop looking generic is to put the actual interface on the page" (real product screenshots over abstract orbs). Granola's human/imperfect direction is the working proof-of-concept. Emerging aesthetics beyond dark-mode-plus-accent: "intentional incompleteness"/schematic-raw/mono-type-inspired layouts, neo-nostalgia, refined (not heavy) translucency, and warm/earthy palettes as a counter-move to sterile RGB.

### 5. Practical craft resources (current best-practice)

* shadcn/ui + Tailwind v4 (shipped Feb–March 2025) is the current default stack for exactly this kind of build: CSS-first theming via the `@theme` directive, all design tokens as CSS variables in `globals.css`, HSL→OKLCH color conversion, the `new-york` default style, `data-slot` attributes on every primitive, `tw-animate-css` replacing `tailwindcss-animate`, and `sonner` replacing the toast component. Zero-config MCP registry support was added May 2025.
* Design-token discipline: define `--mono`, `--radius`, and semantic color tokens; every component references tokens with no hardcoded values — this lets you tune the accent/type identity and swap themes from a single file as trends shift.
* Figma community: up-to-date shadcn/ui token kits (color, type, radius, spacing variables) maintained through 2026; Attio full-UI reference archives (250+ to 1,500+ screens) are the best CRM-pattern reference (Attio's UI is repeatedly called "the best in the CRM category… like Figma for sales data").

## Details

The through-line across every strand of this research is that baseline polish is now free and therefore worthless as a differentiator. AI code tools, templates, and component libraries hand everyone the same tasteful-but-anonymous defaults, so the only defensible position is deliberate, ownable design judgment. Granola is the category's living proof: it spent its design capital on a handwriting-derived typeface and an off-palette green, trended on launch, and rode that distinctiveness into a $1.5B valuation. On the opposite side, Apple's Liquid Glass shows the ceiling on decorative depth — even the world's best-resourced design org got punished for prioritizing spectacle over legibility, and had to ship a cascade of opt-outs. Between those poles sits the concrete craft consensus: dark-first monochrome with one disciplined accent, non-Inter type plus a mono for data, borders-and-elevation over shadows, purposeful motion, and AI states that stream and "show their thinking." The competitor category then hands CallRise its exact wedge — Gong/Salesforce/Avoma are widely experienced as cluttered, dated, and slow, while Fathom proves clean UI wins but leaves sales depth on the table. CallRise's opportunity is the unoccupied quadrant: Fathom-clean, Granola-distinctive, and genuinely sales-deep.

## Recommendations

1. Decide the identity before the pixels (Stage 0). Choose ONE distinctive accent (avoid indigo/violet and default SaaS blue) and one non-Inter UI sans (Geist or Satoshi) plus a mono for data. Change-trigger: if internal testers, shown the app with the logo removed, cannot distinguish it from two named competitors, restart the color/type decision. This is the highest-leverage move and the cheapest to get wrong later.
2. Design dark-first: monochrome + one accent. Keep the accent to ≤~5% of screen; build hierarchy with borders and background-elevation, not heavy shadows. Avoid heavy glass/blur (the Liquid Glass lesson). Derive light mode from dark, not the reverse.
3. Make the AI feel premium through motion and state, not gradients. Ship streaming text, a tasteful "thinking" indicator, and a collapsible "stream-of-thought" reveal for Rise and live coaching, always with a stop button. This is where a sales app can credibly feel "next generation." Benchmark: perceived responsiveness/transparency should match ChatGPT/Perplexity/Claude, not a spinner.
4. Out-clarity Gong and Salesforce. High information density is acceptable (Linear proves it), but only with ruthless progressive disclosure and consistent spacing. Benchmark: aim to match Fathom's ease-of-use perception (its 9.7 G2 score is the bar) while retaining sales depth. Track first-run task-completion time and "where is X" support volume as your clarity metrics.
5. Stage the redesign; never big-bang. Offer an opt-in/preview build and a revert path, and explain the rationale in-product (Discord/Sonos/Netflix/GPT-5 lessons). Change-trigger: any spike in "where did X go" tickets means slow the rollout and add a revert toggle before proceeding.
6. Build on shadcn/ui + Tailwind v4 with strict design tokens so the accent, radius, and type identity are centralized and can evolve from one file as aesthetics shift — future-proofing against the fast churn of trend cycles (a "distinctive in early 2025, cliché by mid-2026" cadence is now normal).

## Caveats

* Many "2026 trends" sources are agency/SEO blogs (single-source opinion), treated here as directional, not authoritative. The strong-consensus items — the AI-generic/purple critique, Gong/Salesforce "cluttered/dated," Inter's over-ubiquity, dark-first design, and the Liquid Glass backlash — are each corroborated across many independent sources.
* Several competitor quotes were surfaced via competitor/vendor blogs (e.g., tl;dv, Oliv.ai); the verbatim user/G2/Capterra quotes are retained but their editorializing is discounted. The Reddit "Windows 95" Salesforce comparison is paraphrased by a consultancy and was not traced to an original post — verify before quoting publicly.
* Private-company funding/ARR figures (Fathom, Fireflies) vary across aggregators; Granola and Read.ai figures are corroborated by tier-1 press. Fireflies' ~$1B is a tender-offer valuation, not a priced VC round.
* Gong's Moving Brands work was a brand/logo identity refresh (~2022 era), not a 2025–2026 in-product UI redesign — do not conflate the two.
* "Next aesthetic move" predictions are forward-looking opinion, not established fact.

---

# What M31 actually did against this research

Written 2026-08-30, when the source text landed. Each row is checkable against
the text above rather than against anyone's memory of it.

| Research says | What M31 built | Verdict |
|---|---|---|
| Avoid Inter; use Geist/Satoshi/General Sans/**Manrope** + a mono for data | Manrope Variable + Geist Mono Variable, both bundled (Inter was named in the stack and never bundled, so Windows rendered Segoe UI) | ✅ named alternative |
| Avoid indigo/violet and default SaaS blue; own one accent | First Light amber-gold `#f0a63b`; the pre-M31 ramp was `#6e7bf2` indigo — the exact named cliché | ✅ |
| Cap top-level nav at 5–7 | 7-item sidebar (was 12) | ✅ |
| Cmd+K palette as the fast path over a browsable sidebar | Both exist | ✅ |
| Empty states teach + offer one action | Stage 3 tri-state empty states, `what` required on every off-state | ✅ |
| Borders + background elevation over heavy shadows | Already the house style; shadows are whisper-soft | ✅ |
| Purposeful motion, never bouncy | `--ease-settle` decelerates without overshoot, and a test **enforces** no-overshoot arithmetically | ✅ |
| Streaming + immediate thinking indicator + **prominent** stop + **collapsible stream-of-thought** | All four now exist in Rise. Stop was the app's quietest button and is now its own high-contrast variant; the stream-of-thought is built from executed outcomes | ✅ Stage 5 items 3–4 are this recommendation, near-verbatim |
| Logo-removed distinguishability test as the change-trigger | Run in Stage 4; scheduled to re-run at close-out with type + colour + motion in | ✅ |
| Stage it, feature-flag it, offer a revert | One preview flag, complete and verified revert path | ✅ |
| **Keep onboarding checklists to ≤4 steps** — Chameleon: ~74% completion at 4 steps, ~16% at 7+ | **The activation checklist has SIX steps** | ⚠️ **CONTRADICTED — see below** |
| Accent ≤~5% of screen (~2% for neon) | Never measured | ⚠️ unverified |

### The one contradiction, and it is a real one

`features/home/activationSteps.ts` builds **six** steps. Round 1 says to keep
checklists to ≤4, on Chameleon data showing completion falling from ~74% at
four steps to ~16% at seven-plus. Six sits inside that decay curve.

Two things soften it and neither dismisses it:

1. It is a **checklist**, not a linear tour — nothing blocks, every step is
   independently actionable, and it is dismissible. The cited collapse is
   measured on tours.
2. `activationProgress()` excludes blocked steps from numerator *and*
   denominator, so an unreachable step never inflates the count.

But the honest reading is that the research recommends four and we shipped
six, and that was not a decision anyone made — it was made in the absence of
the research. Candidates for the two cuts, if the founder wants them: "Coach
one of your calls" (implied by having coached nothing) and "Connect your
calendar" (currently unreachable anyway while Google sign-in is blocked).

**Founder's call, flagged rather than silently actioned.**

### A constraint that will otherwise be re-proposed

**The side-panel transcript (evidence beside claim) is blocked by the window
width floor, not by taste.** It is the best answer for the citation case — the
coaching scorecard quotes the transcript, so claim and evidence want to be
adjacent. It is not buildable today because M31 lowered `minWidth` to **880px**
to fix 125%/150% display scaling, and three columns (sidebar + main + panel)
do not fit there.

Anyone re-proposing it must answer the 880px case first. Recorded at the
founder's instruction, precisely so the next person does not spend the
analysis again.
