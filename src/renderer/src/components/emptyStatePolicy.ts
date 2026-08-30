import type { LucideIcon } from 'lucide-react'
import { KeyRound, Power, AlertTriangle } from 'lucide-react'
import type { SettingsPageId } from '@renderer/features/settings/settings-nav'

/**
 * M31 Stage 3 — the tri-state empty standard, minus the JSX.
 *
 * Founder: *"'nothing here yet' vs 'this is switched off' vs 'this needs a
 * key' point at three different user actions, and right now they all look
 * identical. Getting that wrong is what made me think features were broken
 * when they were just off."*
 *
 * ── WHY THIS IS A SEPARATE FILE FROM EmptyState.tsx ────────────────────────
 *
 * Everything with a RULE in it lives here, so it can be tested. This repo has
 * no component-render infrastructure at all — no React Testing Library, no
 * jsdom/happy-dom environment wired into vitest (`environment: 'node'`), and
 * `include` is `src/**\/*.test.ts`, so a `.test.tsx` is not even collected.
 * Adding all of that to assert on three badges would be a bigger, riskier
 * change than the feature, and would touch how all 281 existing test files
 * are discovered.
 *
 * So the split is the honest one rather than a workaround: the DECISIONS
 * (which action does this state imply, where does it go, does the caller's
 * action win) are pure and tested here; EmptyState.tsx is left as
 * presentation thin enough to read in one pass.
 *
 * ── WHY `off` CARRIES A REQUIRED PAGE ──────────────────────────────────────
 *
 * You cannot say "this is switched off" without naming where to switch it on.
 * A `variant="off"` string would let a caller adopt the honest wording and
 * still leave the user with nowhere to go — the same dead end this stage
 * exists to remove, wearing better copy.
 */
export type EmptyStateReason =
  | { kind: 'empty' }
  | {
      kind: 'off'
      /** Where to turn it on. Required — see above. */
      settingsPage: SettingsPageId
      /**
       * What the feature DOES, in one line. REQUIRED, for the same reason
       * `settingsPage` is.
       *
       * Founder: *"each one should say what the feature DOES, not just that
       * it's off. 'Deal Intelligence is switched off' tells me nothing about
       * whether I want it. 'Deal Intelligence watches live calls for risk
       * signals — switched off' tells me whether to click. Half my 50%
       * problem is not knowing what things ARE, not just that they exist."*
       *
       * It lives on the REASON rather than as a sibling `description` prop
       * deliberately. The first attempt made the component's props a
       * discriminated union so `reason: off` forced `description` — which
       * TypeScript cannot narrow when a call site passes
       * `reason={on ? A : B}`, the natural shape for exactly these screens.
       * Requiring it INSIDE the object being constructed works with that
       * shape, and keeps the guarantee: an off-state that only announces its
       * own absence does not typecheck.
       */
      what: string
      /** What turning it on costs, in one line, where there is a real cost
       *  (e.g. "makes AI calls during the call"). The founder's standing
       *  "smooth default, advertised advanced path" rule: advertise the
       *  advanced path honestly, price included. */
      cost?: string
      /** Overrides the button label where the page name is not the obvious
       *  wording (default: "Turn it on in Settings"). */
      actionLabel?: string
    }
  | {
      kind: 'needsKey'
      /** Defaults to the API-keys page. Overridable only because a future
       *  feature might need a key that lives elsewhere. */
      settingsPage?: SettingsPageId
    }
  | { kind: 'broken'; detail: string }

export interface EmptyStateAction {
  label: string
  onClick: () => void
  icon?: LucideIcon
}

/** How each state announces itself above the title. A closed record, so a new
 *  state cannot be added without deciding how it reads. `empty` has no badge
 *  on purpose: "nothing here yet" is the unremarkable case and does not need
 *  a label shouting at the user. */
export const REASON_BADGE: Record<
  EmptyStateReason['kind'],
  { icon: LucideIcon | null; label: string; tone: string }
> = {
  empty: { icon: null, label: '', tone: '' },
  off: { icon: Power, label: 'Switched off', tone: 'text-muted' },
  needsKey: { icon: KeyRound, label: 'Needs a key', tone: 'text-warning' },
  broken: { icon: AlertTriangle, label: "Didn't load", tone: 'text-danger' }
}

/**
 * The button an empty state should show, given its reason and whatever the
 * caller passed.
 *
 * The caller's own action always wins — some screens' next step genuinely is
 * not Settings. But when they give none, an `off` or `needsKey` state still
 * gets a working button, so a call site that remembered to change the WORDING
 * but forgot the button cannot produce a dead end.
 *
 * `navigate` is injected rather than imported so this stays pure and the test
 * can see where a click would go without mounting anything.
 */
export function resolveEmptyStateAction(
  reason: EmptyStateReason,
  explicit: EmptyStateAction | undefined,
  navigate: (page: SettingsPageId) => void
): EmptyStateAction | null {
  if (explicit) return explicit
  if (reason.kind === 'off') {
    return {
      label: reason.actionLabel ?? 'Turn it on in Settings',
      onClick: () => navigate(reason.settingsPage),
      icon: Power
    }
  }
  if (reason.kind === 'needsKey') {
    // Deliberately the KEYS page, never the feature's own toggle. Sending
    // someone to a switch that is already in the right position teaches them
    // the app is wrong about its own state.
    return {
      label: 'Add a key in Settings',
      onClick: () => navigate(reason.settingsPage ?? 'ai-setup'),
      icon: KeyRound
    }
  }
  // `empty` and `broken` get no invented button: for empty there may be
  // nothing to do but wait, and for broken there is nothing the user can
  // usefully press — saying so plainly is the whole contribution.
  return null
}
