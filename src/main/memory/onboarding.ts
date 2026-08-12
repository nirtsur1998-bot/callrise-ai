// M25 Sales Brain Phase 4 — the onboarding interview (spec section 3's
// "NEW — Onboarding interview"). A FIXED sequence of topics, not an
// open-ended AI-directed conversation — deterministic questions (reliable,
// on-brand, fast, no AI needed just to ask them) with an AI extraction
// pass on each free-text answer. Every extracted fact is source:
// 'user_stated' (spec: "Every answer stored as source: 'user_stated'") —
// the rep is answering a direct question, not being inferred about.
//
// No Electron import — pure/testable, same convention as every other
// module here. State persistence + IPC wiring live in onboarding-ipc.ts.
import type { AITool } from '../ai/types'
import { completeWithFallback } from '../ai/complete-with-fallback'
import { MEMORY_CATEGORIES, CATEGORY_SCOPE_KIND, type MemoryCandidate, type MemoryCategory } from './types'

export interface OnboardingTopic {
  id: string
  question: string
  /** Categories this topic's answer is expected to map to — narrows the
   *  extraction tool's allowed set per-topic (a pricing answer shouldn't
   *  get filed as a "competitor" fact), while still allowing more than one
   *  extracted fact per answer (a rep might mention pricing model AND a
   *  competitor in one breath about "why we're different"). */
  categories: MemoryCategory[]
}

/** Fixed order: business/product first (grounds everything else), then
 *  pricing, ICP, objections, goals — matches the spec's own listed order
 *  ("business, product, pricing, ICP, top objections, goals"), roughly
 *  business-scope facts first, then rep-scope (goals) last. 5-10 minutes
 *  total is the spec's own target — 5 topics, each answerable in 1-2
 *  minutes, fits that. */
export const ONBOARDING_TOPICS: OnboardingTopic[] = [
  {
    id: 'product',
    question: "What do you sell, in a sentence or two? What problem does it actually solve for a customer?",
    categories: ['product-or-service']
  },
  {
    id: 'pricing',
    question: 'How is it priced — model, rough range, anything reps commonly get asked about pricing?',
    categories: ['pricing-model']
  },
  {
    id: 'icp',
    question: "Who's your ideal customer? Company size, industry, role of the person you usually sell to — whatever actually matters.",
    categories: ['icp']
  },
  {
    id: 'objections',
    question: "What's the #1 objection you hear, and what's your best response to it?",
    categories: ['objection-and-response', 'competitor']
  },
  {
    id: 'goals',
    question: "What are you personally trying to get better at as a seller right now?",
    categories: ['stated-goal', 'stated-struggle']
  }
]

export function topicById(id: string): OnboardingTopic | undefined {
  return ONBOARDING_TOPICS.find((t) => t.id === id)
}

function extractTool(allowedCategories: MemoryCategory[]): AITool {
  return {
    name: 'record_onboarding_facts',
    description: 'Record durable facts stated in this onboarding answer.',
    inputSchema: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', enum: allowedCategories },
              statement: {
                type: 'string',
                description: 'One clear, short sentence stating the fact, written in the third person (e.g. "Sells project-management software to mid-market teams").'
              }
            },
            required: ['category', 'statement'],
            additionalProperties: false
          }
        }
      },
      required: ['facts'],
      additionalProperties: false
    }
  }
}

const EXTRACT_PROMPT =
  'The rep just answered an onboarding question about their business/selling. Turn their answer into 1-4 short, clear, factual statements (never invent details not in the answer). Call record_onboarding_facts. If the answer has genuinely nothing usable (e.g. "skip" or "not sure"), return an empty facts array.'

/** Extracts candidate memories from one onboarding answer, all pre-scoped
 *  to 'business' or 'rep' per the category's own fixed CATEGORY_SCOPE_KIND
 *  (never 'client' — onboarding is never about a specific call's contact).
 *  Best-effort, same as every other extraction module: a failure just
 *  means this answer contributes no memories, never an error surfaced to
 *  the rep mid-interview. */
export async function extractOnboardingFacts(topic: OnboardingTopic, answer: string): Promise<MemoryCandidate[]> {
  const text = answer.trim()
  if (!text) return []

  try {
    const result = await completeWithFallback({
      purpose: 'memory-extract',
      maxTokens: 600,
      tool: extractTool(topic.categories),
      messages: [{ role: 'user', content: `${EXTRACT_PROMPT}\n\nQuestion asked: "${topic.question}"\n\n--- REP'S ANSWER ---\n${text}` }]
    })
    const raw = Array.isArray(result.toolInput?.facts) ? result.toolInput.facts : []
    const out: MemoryCandidate[] = []
    for (const item of raw.slice(0, 4)) {
      if (!item || typeof item !== 'object') continue
      const r = item as Record<string, unknown>
      const category = r.category
      const statement = typeof r.statement === 'string' ? r.statement.trim().slice(0, 500) : ''
      if (!statement) continue
      if (typeof category !== 'string' || !(MEMORY_CATEGORIES as readonly string[]).includes(category)) continue
      if (!topic.categories.includes(category as MemoryCategory)) continue // stay within THIS topic's allowed set
      const scopeKind = CATEGORY_SCOPE_KIND[category as MemoryCategory]
      if (scopeKind === 'client') continue // never reachable given topic.categories never includes a client-fact category, but a hard guard anyway
      out.push({
        scope: scopeKind,
        category: category as MemoryCategory,
        statement,
        evidence: [{ type: 'transcript', callId: `onboarding:${topic.id}`, quote: text.slice(0, 400) }],
        confidence: 0.95,
        importance: 7,
        source: 'user_stated'
      })
    }
    return out
  } catch {
    return []
  }
}
