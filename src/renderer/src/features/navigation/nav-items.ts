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
  type LucideIcon
} from 'lucide-react'

export type NavId =
  | 'home'
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
