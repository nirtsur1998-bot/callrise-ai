import {
  Home,
  PhoneCall,
  History,
  ListChecks,
  Contact,
  Calendar,
  GraduationCap,
  BarChart3,
  UsersRound,
  BookOpen,
  Settings,
  Sparkles,
  Briefcase,
  Library,
  type LucideIcon
} from 'lucide-react'
import { ASSISTANT_SECTION_NAME } from '../assistant/config'

export type NavId =
  | 'home'
  | 'assistant'
  | 'live-calls'
  | 'past-calls'
  | 'tasks'
  | 'crm'
  | 'calendar'
  | 'coaching'
  | 'analytics'
  | 'team'
  | 'knowledge'
  | 'settings'
  // M31 Stage 2 — the 7-item preview IA's three merged hubs. These are NEW
  // ids, not replacements: every id above keeps working exactly as it does
  // today (MainApp never removes a case), so a deep link, a saved "recent"
  // entry, or a palette search minted before a user turned the preview on
  // still lands somewhere real either way.
  | 'calls'
  | 'pipeline'
  | 'library'

export interface NavItem {
  id: NavId
  label: string
  icon: LucideIcon
  /** Group header the sidebar renders above this item's section. Items
   *  sharing a section render as one contiguous group, in list order. */
  section?: string
}

/** The left-sidebar navigation. Order here is the order shown. */
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: Home, section: 'Workspace' },
  // M28 — the display name comes from the ONE naming constant; the id stays
  // 'assistant' so a rename never touches code identity.
  { id: 'assistant', label: ASSISTANT_SECTION_NAME, icon: Sparkles, section: 'Workspace' },
  { id: 'live-calls', label: 'Live Calls', icon: PhoneCall, section: 'Workspace' },
  { id: 'past-calls', label: 'Past Calls', icon: History, section: 'Workspace' },
  { id: 'tasks', label: 'Tasks', icon: ListChecks, section: 'Workspace' },
  { id: 'crm', label: 'CRM', icon: Contact, section: 'Pipeline' },
  { id: 'calendar', label: 'Calendar', icon: Calendar, section: 'Pipeline' },
  { id: 'coaching', label: 'Coaching', icon: GraduationCap, section: 'Insights' },
  { id: 'analytics', label: 'Analytics', icon: BarChart3, section: 'Insights' },
  { id: 'team', label: 'Team', icon: UsersRound, section: 'Library' },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen, section: 'Library' },
  { id: 'settings', label: 'Settings', icon: Settings }
]

/** M31 Stage 2 — the approved 7-item IA (docs/M31-design-audit.md §5.2),
 *  behind the `navigationPreview` flag (see useNavigationPreview.ts). Same
 *  NavId type, same Sidebar/CommandPalette rendering code as NAV_ITEMS above
 *  — only the list differs, so turning the flag off is a complete, instant
 *  revert to the array above with zero other code changes.
 *
 *  Three items each open a "hub" (a thin SegmentedControl wrapper around
 *  screens that are otherwise completely unchanged — see CallsHub.tsx,
 *  PipelineHub.tsx, LibraryHub.tsx): Calls merges Live + Past (the live pill
 *  already shows cross-screen, so "which tab am I on" never hides a live
 *  call); Pipeline merges CRM + Tasks + Calendar; Library merges Knowledge +
 *  Battlecards (new) + the Objection review queue (graduated out of
 *  Settings, which keeps only the mining on/off toggle and the scan
 *  trigger). Coaching gains two more internal tabs (Performance = today's
 *  Analytics, Your Trend = today's Team) via the same CoachingHub pattern,
 *  without changing its NavId. */
export const NAV_ITEMS_PREVIEW: NavItem[] = [
  { id: 'home', label: 'Home', icon: Home, section: 'Workspace' },
  { id: 'assistant', label: ASSISTANT_SECTION_NAME, icon: Sparkles, section: 'Workspace' },
  { id: 'calls', label: 'Calls', icon: PhoneCall, section: 'Workspace' },
  { id: 'pipeline', label: 'Pipeline', icon: Briefcase, section: 'Workspace' },
  { id: 'coaching', label: 'Coaching', icon: GraduationCap, section: 'Insights' },
  { id: 'library', label: 'Library', icon: Library, section: 'Insights' },
  { id: 'settings', label: 'Settings', icon: Settings }
]

// Every legacy id that a preview-mode hub absorbs, so MainApp's internal
// navigation (detection auto-start, palette jumps, deep links — anything
// that used to setActive('live-calls') etc. directly) lands on the right
// hub instead of a screen the 7-item sidebar has no entry for.
export const OLD_TO_HUB: Partial<Record<NavId, NavId>> = {
  'live-calls': 'calls',
  'past-calls': 'calls',
  crm: 'pipeline',
  tasks: 'pipeline',
  calendar: 'pipeline',
  analytics: 'coaching',
  team: 'coaching',
  knowledge: 'library'
}

/**
 * Which TAB inside the hub each absorbed legacy id actually is.
 *
 * OLD_TO_HUB above answers "which screen" and throws away "which part of
 * it" — so navigating to past-calls landed on the Calls hub showing LIVE,
 * and navigating to tasks landed on the Pipeline hub showing CRM. Both are
 * plausible destinations, which is what made it hard to notice: nothing
 * failed, you just arrived somewhere adjacent to where you asked for.
 *
 * Founder-reported, twice in one session, from the Home stat cards ("Tasks
 * due" -> CRM, "Calls today" -> Live call). The id was never wrong; the
 * remap simply had nowhere to put the second half of the answer.
 *
 * Every key here must also be a key of OLD_TO_HUB — a legacy id that maps
 * to a hub without saying which tab is exactly the bug this fixes.
 * nav-items-hub-mapping.test.ts asserts that pairing both ways.
 */
export const OLD_TO_HUB_TAB: Partial<Record<NavId, string>> = {
  'live-calls': 'live',
  'past-calls': 'past',
  crm: 'crm',
  tasks: 'tasks',
  calendar: 'calendar',
  analytics: 'performance',
  team: 'trend',
  knowledge: 'knowledge'
}

// The inverse, for the hub ids with no single legacy screen already covering
// both nav sets ('coaching' is valid in NAV_ITEMS too, so it needs no entry
// here — MainApp's own render switch downgrades it to CoachingView directly).
// Each target is that hub's own default tab, so reverting reads as "this hub,
// before it existed" rather than an arbitrary pick. Keep this in sync with
// NAV_ITEMS_PREVIEW: nav-items-hub-mapping.test.ts asserts every hub-only id
// (one that isn't also in NAV_ITEMS) has an entry here, so a future hub added
// without one fails the suite instead of shipping an orphaned screen.
export const HUB_TO_OLD: Partial<Record<NavId, NavId>> = {
  calls: 'live-calls',
  pipeline: 'crm',
  library: 'knowledge'
}

/** Which id to be on after `previewEnabled` changes, given the id you were on
 *  a moment ago — the single source of truth for both directions of the
 *  preview-flag revert path. Pure and stateless so it's testable without
 *  mounting MainApp; see OLD_TO_HUB/HUB_TO_OLD for what each direction maps. */
export function remapForPreview(id: NavId, previewEnabled: boolean): NavId {
  return previewEnabled ? (OLD_TO_HUB[id] ?? id) : (HUB_TO_OLD[id] ?? id)
}
