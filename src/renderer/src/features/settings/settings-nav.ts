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
  type LucideIcon
} from 'lucide-react'

export type SettingsPageId =
  | 'account'
  | 'ai-setup'
  | 'ai-note-taker'
  | 'call-detection'
  | 'recording-consent'
  | 'audio'
  | 'coaching'
  | 'summary-language'
  | 'personalization'
  | 'objection-library'
  | 'calendar'
  | 'crm'
  | 'app'
  | 'appearance'
  | 'privacy-data'

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

export const SETTINGS_GROUPS: SettingsGroup[] = [
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
          'Your own Deepgram (transcription) and Anthropic (coaching & summaries) keys — required for those features to work.'
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
      }
    ]
  }
]

export const ALL_SETTINGS_PAGES: SettingsPageItem[] = SETTINGS_GROUPS.flatMap((g) => g.items)
