import {
  User,
  Lock,
  Mic2,
  Sparkles,
  Languages,
  UserCircle,
  CalendarDays,
  Cog,
  SunMoon,
  ShieldCheck,
  NotebookPen,
  Contact,
  MessageSquareQuote,
  KeyRound,
  Radar,
  BellRing,
  Layers,
  Activity,
  HeartPulse,
  GraduationCap,
  Brain,
  ListTodo,
  type LucideIcon
} from 'lucide-react'

export type SettingsPageId =
  | 'account'
  | 'ai-setup'
  | 'ai-models'
  | 'ai-note-taker'
  | 'call-detection'
  | 'recording-consent'
  | 'audio'
  | 'coaching'
  | 'live-deal-intelligence'
  | 'summary-language'
  | 'personalization'
  | 'objection-library'
  | 'coach2'
  | 'sales-brain'
  | 'sales-brain-memories'
  | 'calendar'
  | 'crm'
  | 'alerts'
  | 'app'
  | 'appearance'
  | 'privacy-data'
  | 'telemetry'
  | 'jobs-inspector'

export interface SettingsPageItem {
  id: SettingsPageId
  label: string
  icon: LucideIcon
  description?: string
}

export interface SettingsGroup {
  /** Omit for the top (unlabeled) group, matching Krisp's "Account" placement. */
  label?: string
  items: SettingsPageItem[]
}

// BUG-083 (M29 audit, 2026-08-23): the Scheduled Alerts backend — five tables
// and four edge functions in supabase/ — was never deployed to the live
// project, so every control on the Alerts page has failed for every user
// since M19 shipped. Until the backend is genuinely live (verified end to
// end, not merely committed — see the vault's "shipped as code but never as
// deployment" taxonomy entry), the page is hidden rather than left lying.
// Flipping this to true is the WHOLE un-hide; planned as part of the future
// paid-cloud alerts deployment, not as a quiet default.
export const ALERTS_BACKEND_LIVE = false

/** Exported so the regression test can prove the switch is wired BOTH ways
 *  (a nav entry that ignores its flag is taxonomy species 17).
 *
 *  `preview` selects the M31 Stage 5 information architecture (V2_GROUPS)
 *  over the one the app shipped with (ALL_GROUPS). Both are filtered by the
 *  alerts flag through this one shared line on purpose — a page hidden
 *  because its backend was never deployed must stay hidden in either IA, and
 *  two separate filters is how one of them eventually stops matching. */
export function buildSettingsGroups(alertsBackendLive: boolean, preview = false): SettingsGroup[] {
  const groups = preview ? V2_GROUPS : ALL_GROUPS
  return groups.filter((g) => alertsBackendLive || !g.items.some((item) => item.id === 'alerts'))
}

const ALL_GROUPS: SettingsGroup[] = [
  {
    items: [{ id: 'account', label: 'Account', icon: User }]
  },
  {
    label: 'AI Setup',
    items: [
      {
        id: 'ai-setup',
        label: 'API keys',
        icon: KeyRound,
        description:
          'Your own Deepgram (transcription) and text-AI provider keys — required for those features to work.'
      },
      {
        id: 'ai-models',
        label: 'Model Assignment',
        icon: Layers,
        description:
          'Which model handles each of the 10 AI jobs — live coaching cues, post-call summaries, scorecards, task extraction, prep briefs, deal intelligence, coaching chat, Sales Brain extraction, and Rise — with an automatic fallback chain if one is unavailable.'
      }
    ]
  },
  {
    label: 'Meeting Assistant',
    items: [
      {
        id: 'ai-note-taker',
        label: 'AI Note Taker',
        icon: NotebookPen,
        description:
          'What happens automatically around a call — starting, opening, summarizing, titling — and which apps to skip auto-start for.'
      },
      {
        id: 'call-detection',
        label: 'Call detection',
        icon: Radar,
        description:
          'Notice on its own when you’re on a call and start capturing without a click — capture policy and per-app overrides.'
      }
    ]
  },
  {
    label: 'Recording',
    items: [
      {
        id: 'recording-consent',
        label: 'Recording & consent',
        icon: Lock,
        description:
          'The buyer-recording master switch, default jurisdiction, and disclosure script.'
      }
    ]
  },
  {
    label: 'Audio',
    items: [
      {
        id: 'audio',
        label: 'Audio',
        icon: Mic2,
        description: 'Noise cancellation.'
      }
    ]
  },
  {
    label: 'AI & coaching',
    items: [
      {
        id: 'coaching',
        label: 'Coaching',
        icon: Sparkles,
        description: 'Default sensitivity for live coaching cues.'
      },
      {
        id: 'live-deal-intelligence',
        label: 'Live Deal Intelligence',
        icon: Activity,
        description:
          "Beta: real-time deal-risk radar and next-level coaching cues, watching the live call against this deal's context."
      },
      {
        id: 'summary-language',
        label: 'Summary language',
        icon: Languages,
        description: 'The language AI-generated summaries are written in.'
      },
      {
        id: 'personalization',
        label: 'Personalization',
        icon: UserCircle,
        description: 'Feeds AI-generated summaries and coaching so they understand who you are.'
      },
      {
        id: 'objection-library',
        label: 'Objection Library',
        icon: MessageSquareQuote,
        description:
          'Let AI read your call transcripts to suggest reusable objection-handling scripts. Off by default; you approve every suggestion before it becomes a real script.'
      },
      {
        id: 'coach2',
        label: 'Coach 2.0',
        icon: GraduationCap,
        description:
          'Benchmarks, an 8-skill progress graph, a methodology picker, and the Focus Skill loop. Off by default.'
      },
      {
        id: 'sales-brain',
        label: 'Sales Brain (Beta)',
        icon: Brain,
        description:
          'Learns who you are, how you sell, your business, and each client — every AI feature gets smarter from it. Runs entirely on your own device. Off by default.'
      },
      {
        id: 'sales-brain-memories',
        label: 'Sales Brain — Memories',
        icon: Brain,
        description:
          'Browse, edit, pin, or delete anything Sales Brain has learned. Full history, nothing hidden.'
      }
    ]
  },
  {
    label: 'Calendar',
    items: [
      {
        id: 'calendar',
        label: 'Calendar',
        icon: CalendarDays,
        description: 'Connect Google Calendar and manage two-way sync.'
      }
    ]
  },
  {
    label: 'CRM',
    items: [
      {
        id: 'crm',
        label: 'Contacts & matching',
        icon: Contact,
        description:
          'Calendar-match suggestions, default country, and auto-numbered customer IDs for Contacts.'
      }
    ]
  },
  {
    label: 'Alerts',
    items: [
      {
        id: 'alerts',
        label: 'Scheduled alerts',
        icon: BellRing,
        description:
          'Reminders for meetings, tasks, cooling deals, and missed next steps — delivered to Telegram, email, or desktop, even when the app is closed.'
      }
    ]
  },
  {
    label: 'App',
    items: [
      {
        id: 'app',
        label: 'App',
        icon: Cog,
        description: 'General app behavior.'
      },
      {
        id: 'appearance',
        label: 'Appearance',
        icon: SunMoon,
        description: 'Choose a dark or light theme, or follow your system setting.'
      }
    ]
  },
  {
    label: 'Privacy',
    items: [
      {
        id: 'privacy-data',
        label: 'Privacy & data',
        icon: ShieldCheck,
        description: 'What stays on this device, and what backs up to your account.'
      },
      {
        id: 'telemetry',
        label: 'Diagnostics & telemetry',
        icon: HeartPulse,
        description:
          'Off unless you turn it on. Anonymous crash and health reports — never your calls, notes, or keys. See exactly what would be sent.'
      }
    ]
  },
  // M26 Phase 1 — dev builds only. Never appears in a packaged build: the
  // whole group is omitted rather than the page just being unreachable, so
  // there's nothing here for a real user to even notice.
  ...(import.meta.env.DEV
    ? [
        {
          label: 'Developer',
          items: [
            {
              id: 'jobs-inspector' as const,
              label: 'Job Inspector',
              icon: ListTodo,
              description:
                'The background job queue — lanes, cancellation, resume — with fake jobs to exercise it without touching any real feature.'
            }
          ]
        }
      ]
    : [])
]

// ── M31 Stage 5: the reworked Settings IA ───────────────────────────────────
//
// The shipped IA above has 21 pages under 11 groups. The founder's report was
// "they all look quite messy"; measured, three things were true:
//
//   • One group held 8 of the 21 pages ("AI & coaching"). A bucket holding 38%
//     of everything has stopped sorting — and no user-facing model separates
//     "Coaching" from "Coach 2.0" from "Live Deal Intelligence".
//   • Eleven groups produce ten inter-group gaps. The nav has ALWAYS suppressed
//     the heading of a single-item group (SettingsShell's
//     `group.items.length > 1`), so those groups never cost a text row — but
//     each still costs a gap, and ten of them is most of the overflow.
//     Correcting my own audit doc here: it claimed five headings were
//     rendering and earning nothing. They were not rendering at all. The
//     conclusion survived; the stated mechanism was wrong.
//   • Six pages were named after the subsystem that implements them rather
//     than after what the user came to do.
//
// V2 regroups around the JOB, renames the inside-out labels, and merges two
// pairs that were one concept in two rows. Nothing is deleted: every page
// below still exists, and the two absorbed ids still resolve — see
// LEGACY_PAGE_REDIRECTS.
const V2_GROUPS: SettingsGroup[] = [
  {
    items: [{ id: 'account', label: 'Account', icon: User }]
  },
  {
    label: 'Calls',
    items: [
      {
        id: 'recording-consent',
        label: 'Recording & consent',
        icon: Lock,
        description:
          'The buyer-recording master switch, default jurisdiction, and disclosure script.'
      },
      {
        id: 'call-detection',
        label: 'Call detection',
        icon: Radar,
        description:
          'Notice on its own when you’re on a call and start capturing without a click — capture policy and per-app overrides.'
      },
      {
        // Absorbs 'summary-language'. "AI Note Taker" is a feature name; what
        // you come here to change is what gets written down after a call, and
        // what language it is written in. Those were two separate rows.
        id: 'ai-note-taker',
        label: 'Notes & summaries',
        icon: NotebookPen,
        description:
          'What gets written down around a call — when it starts, opens, summarizes and titles itself, which apps to skip, and the language summaries are written in.'
      },
      {
        id: 'audio',
        label: 'Audio',
        icon: Mic2,
        description: 'Noise cancellation.'
      }
    ]
  },
  {
    label: 'Coaching',
    items: [
      {
        // Absorbs 'coach2'. Live-cue sensitivity and the skills programme are
        // both "coaching" to anyone not reading the roadmap.
        id: 'coaching',
        label: 'Coaching',
        icon: Sparkles,
        description:
          'How often live cues interrupt you, plus benchmarks, the 8-skill progress graph, methodology, and the Focus Skill loop.'
      },
      {
        id: 'live-deal-intelligence',
        label: 'Deal risk during calls',
        icon: Activity,
        description:
          "Beta: real-time deal-risk radar and next-level coaching cues, watching the live call against this deal's context."
      },
      {
        id: 'objection-library',
        label: 'Objection Library',
        icon: MessageSquareQuote,
        description:
          'Let AI read your call transcripts to suggest reusable objection-handling scripts. Off by default; you approve every suggestion before it becomes a real script.'
      }
    ]
  },
  {
    label: 'Your AI',
    items: [
      {
        id: 'ai-setup',
        label: 'API keys',
        icon: KeyRound,
        description:
          'Your own Deepgram (transcription) and text-AI provider keys — required for those features to work.'
      },
      {
        id: 'ai-models',
        label: 'Which model does what',
        icon: Layers,
        description:
          'Which model handles each of the 10 AI jobs — live coaching cues, post-call summaries, scorecards, task extraction, prep briefs, deal intelligence, coaching chat, Sales Brain extraction, and Rise — with an automatic fallback chain if one is unavailable.'
      },
      {
        id: 'personalization',
        label: 'About you',
        icon: UserCircle,
        description: 'Feeds AI-generated summaries and coaching so they understand who you are.'
      },
      {
        id: 'sales-brain',
        label: 'What CallRise remembers',
        icon: Brain,
        description:
          'Beta: learns who you are, how you sell, your business, and each client — every AI feature gets smarter from it. Runs entirely on your own device. Off by default.'
      },
      {
        // DELIBERATELY NOT merged into 'sales-brain'. This is the one merge the
        // audit proposed that was dropped on purpose: it is where a person
        // browses, edits, pins and DELETES what the AI has learned about them.
        // Folding a data-deletion surface into a 316-line feature page as a
        // sub-section puts distance between someone and their own data, which
        // is a change to what a user can REACH rather than to how things are
        // grouped — outside what "tidy the grouping" was asked to do. Renamed
        // to read as the child of the row above instead, so the pairing is
        // obvious without either one being hidden.
        id: 'sales-brain-memories',
        label: 'Review what it remembers',
        icon: Brain,
        description:
          'Browse, edit, pin, or delete anything Sales Brain has learned. Full history, nothing hidden.'
      }
    ]
  },
  {
    label: 'Connections',
    items: [
      {
        id: 'calendar',
        label: 'Calendar',
        icon: CalendarDays,
        description: 'Connect Google Calendar and manage two-way sync.'
      },
      {
        id: 'crm',
        label: 'Contact matching',
        icon: Contact,
        description:
          'Calendar-match suggestions, default country, and auto-numbered customer IDs for Contacts.'
      }
    ]
  },
  {
    label: 'Alerts',
    items: [
      {
        id: 'alerts',
        label: 'Scheduled alerts',
        icon: BellRing,
        description:
          'Reminders for meetings, tasks, cooling deals, and missed next steps — delivered to Telegram, email, or desktop, even when the app is closed.'
      }
    ]
  },
  {
    label: 'App',
    items: [
      {
        // Appearance first: it is the most-visited page in this group and it
        // holds the preview toggles. Deliberately NOT merged with 'app' —
        // another pair the audit proposed merging that should stay split,
        // because "how it looks" and "how it behaves" are different errands.
        id: 'appearance',
        label: 'Appearance',
        icon: SunMoon,
        description: 'Choose a dark or light theme, or follow your system setting.'
      },
      {
        id: 'app',
        label: 'General',
        icon: Cog,
        description: 'General app behavior.'
      },
      {
        id: 'privacy-data',
        label: 'Privacy & data',
        icon: ShieldCheck,
        description: 'What stays on this device, and what backs up to your account.'
      },
      {
        id: 'telemetry',
        label: 'Crash reports',
        icon: HeartPulse,
        description:
          'Off unless you turn it on. Anonymous crash and health reports — never your calls, notes, or keys. See exactly what would be sent.'
      }
    ]
  },
  ...(import.meta.env.DEV
    ? [
        {
          label: 'Developer',
          items: [
            {
              id: 'jobs-inspector' as const,
              label: 'Background jobs',
              icon: ListTodo,
              description:
                'The background job queue — lanes, cancellation, resume — with fake jobs to exercise it without touching any real feature.'
            }
          ]
        }
      ]
    : [])
]

/** Pages the V2 IA absorbs into another page, and where they now live.
 *
 *  Nothing points at a settings page by id today — SettingsShell always opens
 *  on 'account' and no caller passes a target — so this fixes no live link,
 *  and saying so is more useful than implying it rescued something. It exists
 *  because the approved discoverability policy adds settings deep links
 *  later, and a link written against 'summary-language' should land somewhere
 *  real rather than silently fall through to Account. */
export const LEGACY_PAGE_REDIRECTS: Partial<Record<SettingsPageId, SettingsPageId>> = {
  'summary-language': 'ai-note-taker',
  coach2: 'coaching'
}

/** Resolve any historical page id to one that exists in the given IA. */
export function resolvePageId(id: SettingsPageId, groups: SettingsGroup[]): SettingsPageId {
  if (groups.some((g) => g.items.some((item) => item.id === id))) return id
  return LEGACY_PAGE_REDIRECTS[id] ?? id
}

export const SETTINGS_GROUPS: SettingsGroup[] = buildSettingsGroups(ALERTS_BACKEND_LIVE)

export const ALL_SETTINGS_PAGES: SettingsPageItem[] = SETTINGS_GROUPS.flatMap((g) => g.items)
