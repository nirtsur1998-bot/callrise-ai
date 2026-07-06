import { MessageSquareWarning, Package, BookOpenText, type LucideIcon } from 'lucide-react'
import type { KnowledgeCategory } from './types'

export interface CategoryMeta {
  label: string
  singular: string
  icon: LucideIcon
  description: string
  addLabel: string
  emptyTitle: string
  emptyBody: string
}

export const CATEGORY_META: Record<KnowledgeCategory, CategoryMeta> = {
  objection: {
    label: 'Objection scripts',
    singular: 'objection script',
    icon: MessageSquareWarning,
    description: 'Pairs of what a buyer raises and exactly how you respond.',
    addLabel: 'Add objection script',
    emptyTitle: 'No objection scripts yet',
    emptyBody: 'Add the pushbacks you hear most, and the response that works.'
  },
  product: {
    label: 'Product info',
    singular: 'product section',
    icon: Package,
    description: "What you offer, key features, and what you DON'T offer.",
    addLabel: 'Add product section',
    emptyTitle: 'No product info yet',
    emptyBody: 'Add sections like "What we offer" or "What we don’t offer".'
  },
  playbook: {
    label: 'Sales playbook',
    singular: 'playbook section',
    icon: BookOpenText,
    description: 'Your process, pitch, discovery questions, and positioning.',
    addLabel: 'Add playbook section',
    emptyTitle: 'No playbook sections yet',
    emptyBody: 'Add sections like "Discovery questions" or "Positioning".'
  }
}

export const CATEGORY_ORDER: KnowledgeCategory[] = ['objection', 'product', 'playbook']
