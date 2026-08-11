// M23 — persistence for the current Focus Skill (focus-skill.ts's pure
// selection logic). One small JSON file, same shape as crm-settings.ts:
// async I/O, atomic write, a safe "no focus yet" default on any read
// failure. Kept OUT of app-settings.ts deliberately — this updates after
// every coached call (not a rare settings edit), and is state the loop
// derives, not a preference the rep sets directly.
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '../atomic-write'
import type { FocusSkillState } from './focus-skill'
import type { SkillKey } from '../calls-fs'
import { SKILL_KEYS } from '../calls-fs'

function focusSkillPath(): string {
  return join(app.getPath('userData'), 'coach2-focus-skill.json')
}

function isSkillKey(v: unknown): v is SkillKey {
  return typeof v === 'string' && (SKILL_KEYS as string[]).includes(v)
}

function sanitize(value: unknown): FocusSkillState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isSkillKey(v.skill)) return null
  if (typeof v.microBehavior !== 'string' || !v.microBehavior.trim()) return null
  if (typeof v.since !== 'string' || Number.isNaN(Date.parse(v.since))) return null
  return {
    skill: v.skill,
    microBehavior: v.microBehavior.slice(0, 500),
    since: v.since,
    sourceCallId: typeof v.sourceCallId === 'string' ? v.sourceCallId.slice(0, 200) : undefined
  }
}

export async function loadFocusSkill(): Promise<FocusSkillState | null> {
  try {
    const raw = await fs.readFile(focusSkillPath(), 'utf8')
    return sanitize(JSON.parse(raw))
  } catch {
    return null // no focus set yet — the caller falls back to "pick the lowest skill"
  }
}

export async function saveFocusSkill(state: FocusSkillState): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(focusSkillPath(), state)
}
