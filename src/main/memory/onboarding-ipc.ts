// M25 Sales Brain Phase 4 — onboarding interview state + IPC. One small
// JSON file (same convention as focus-skill-fs.ts): async I/O, atomic
// write, a safe "not started yet" default on any read failure.
import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '../atomic-write'
import { isSalesBrainEnabled } from '../app-settings'
import { getMemoryDb } from './memory-runtime'
import { consolidateNewCandidate } from './consolidation'
import { ONBOARDING_TOPICS, extractOnboardingFacts, topicById } from './onboarding'

interface OnboardingState {
  completedTopicIds: string[]
  skippedAt?: string
  finishedAt?: string
}

const EMPTY_STATE: OnboardingState = { completedTopicIds: [] }

function statePath(): string {
  return join(app.getPath('userData'), 'sales-brain-onboarding.json')
}

function sanitize(value: unknown): OnboardingState {
  if (!value || typeof value !== 'object') return { ...EMPTY_STATE }
  const v = value as Record<string, unknown>
  const validIds = new Set(ONBOARDING_TOPICS.map((t) => t.id))
  const completedTopicIds = Array.isArray(v.completedTopicIds)
    ? v.completedTopicIds.filter((id): id is string => typeof id === 'string' && validIds.has(id))
    : []
  return {
    completedTopicIds,
    skippedAt: typeof v.skippedAt === 'string' ? v.skippedAt : undefined,
    finishedAt: typeof v.finishedAt === 'string' ? v.finishedAt : undefined
  }
}

async function loadState(): Promise<OnboardingState> {
  try {
    return sanitize(JSON.parse(await fs.readFile(statePath(), 'utf8')))
  } catch {
    return { ...EMPTY_STATE }
  }
}

async function saveState(state: OnboardingState): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(statePath(), state)
}

export interface OnboardingStatusResult {
  /** Not started, mid-way, skipped, or genuinely finished — the renderer
   *  decides whether to show the first-run prompt from this alone. */
  status: 'not-started' | 'in-progress' | 'skipped' | 'finished'
  /** The next unanswered topic, or null once every topic is done. Present
   *  even mid-'skipped' state, so re-running from Settings (spec:
   *  "re-runnable from settings") always knows where to resume, not just
   *  where it left off before being skipped. */
  nextTopic: { id: string; question: string } | null
  completedCount: number
  totalCount: number
}

async function computeStatus(): Promise<OnboardingStatusResult> {
  const state = await loadState()
  const remaining = ONBOARDING_TOPICS.find((t) => !state.completedTopicIds.includes(t.id))
  const status: OnboardingStatusResult['status'] = state.finishedAt
    ? 'finished'
    : state.skippedAt
      ? 'skipped'
      : state.completedTopicIds.length > 0
        ? 'in-progress'
        : 'not-started'
  return {
    status,
    nextTopic: remaining ? { id: remaining.id, question: remaining.question } : null,
    completedCount: state.completedTopicIds.length,
    totalCount: ONBOARDING_TOPICS.length
  }
}

let registered = false

export function registerOnboarding(): void {
  if (registered) return
  registered = true

  ipcMain.handle('salesBrain:onboarding:status', async (): Promise<OnboardingStatusResult> => {
    return computeStatus()
  })

  ipcMain.handle(
    'salesBrain:onboarding:submitAnswer',
    async (_e, topicId: unknown, answer: unknown): Promise<OnboardingStatusResult> => {
      if (typeof topicId !== 'string' || typeof answer !== 'string') return computeStatus()
      const topic = topicById(topicId)
      if (!topic) return computeStatus()

      if (isSalesBrainEnabled()) {
        const db = getMemoryDb()
        if (db) {
          const candidates = await extractOnboardingFacts(topic, answer.slice(0, 4000))
          for (const candidate of candidates) {
            await consolidateNewCandidate(db, candidate)
          }
        }
      }

      const state = await loadState()
      if (!state.completedTopicIds.includes(topicId)) {
        state.completedTopicIds = [...state.completedTopicIds, topicId]
      }
      if (state.completedTopicIds.length >= ONBOARDING_TOPICS.length) {
        state.finishedAt = new Date().toISOString()
      }
      await saveState(state)
      return computeStatus()
    }
  )

  // Skips just the CURRENT topic (an "I'd rather not answer this one"
  // escape hatch) — distinct from the whole-interview skip below.
  ipcMain.handle(
    'salesBrain:onboarding:skipTopic',
    async (_e, topicId: unknown): Promise<OnboardingStatusResult> => {
      if (typeof topicId !== 'string' || !topicById(topicId)) return computeStatus()
      const state = await loadState()
      if (!state.completedTopicIds.includes(topicId)) {
        state.completedTopicIds = [...state.completedTopicIds, topicId]
      }
      if (state.completedTopicIds.length >= ONBOARDING_TOPICS.length) {
        state.finishedAt = new Date().toISOString()
      }
      await saveState(state)
      return computeStatus()
    }
  )

  ipcMain.handle('salesBrain:onboarding:skipAll', async (): Promise<OnboardingStatusResult> => {
    const state = await loadState()
    state.skippedAt = new Date().toISOString()
    await saveState(state)
    return computeStatus()
  })

  // Spec: "re-runnable from settings" — starts over from topic 1, without
  // touching any memories already saved from a prior run (re-running never
  // deletes anything, it just asks again; consolidateNewCandidate's own
  // dedupe means re-answering the same way just reinforces, not
  // duplicates).
  ipcMain.handle('salesBrain:onboarding:restart', async (): Promise<OnboardingStatusResult> => {
    await saveState({ ...EMPTY_STATE })
    return computeStatus()
  })
}
