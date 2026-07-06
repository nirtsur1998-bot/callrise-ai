// Renderer-side knowledge types. These mirror the shapes exposed by the
// preload bridge (see src/preload/index.d.ts); kept local so the feature is
// self-contained, matching the tasks/calls features' convention.

export type KnowledgeCategory = 'objection' | 'product' | 'playbook'

interface KnowledgeEntryBase {
  id: string
  category: KnowledgeCategory
  createdAt: string
  updatedAt: string
}

/** Objection-handling script: what the buyer says, and how I respond. */
export interface ObjectionEntry extends KnowledgeEntryBase {
  category: 'objection'
  trigger: string
  response: string
}

/** A free-text section: product info or a playbook section. */
export interface TextEntry extends KnowledgeEntryBase {
  category: 'product' | 'playbook'
  title: string
  body: string
}

export type KnowledgeEntry = ObjectionEntry | TextEntry

export type KnowledgeSizeLevel = 'ok' | 'large' | 'over'

export interface KnowledgeContextPreview {
  text: string
  charCount: number
  estimatedTokens: number
  level: KnowledgeSizeLevel
}
