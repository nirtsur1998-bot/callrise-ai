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
}

/** The left-sidebar navigation. Order here is the order shown. */
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'live-calls', label: 'Live Calls', icon: PhoneCall },
  { id: 'past-calls', label: 'Past Calls', icon: History },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'crm', label: 'CRM', icon: Contact },
  { id: 'calendar', label: 'Calendar', icon: Calendar },
  { id: 'coaching', label: 'Coaching', icon: GraduationCap },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'team', label: 'Team', icon: UsersRound },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'settings', label: 'Settings', icon: Settings }
]
