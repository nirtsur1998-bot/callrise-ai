// Voice-profile matching (M19 Task 2, Part B step 6) — SCHEMA ONLY.
//
// The brief: "after a speaker is named, store an embedding keyed to the
// contact for instant recognition on later calls... this is biometric data
// with real regulatory weight (GDPR, BIPA). Default it off, require explicit
// opt-in, and implement retention + deletion. Design the schema now; ship
// behind a flag."
//
// What this file deliberately does NOT do: compute a real voice embedding.
// That needs an actual speaker-embedding model (e.g. a resemblyzer/pyannote-
// class network) — a genuine ML dependency this repo does not have and
// CLAUDE.md is explicit should not be added ad hoc ("A Python/FastAPI
// backend is planned for LATER... do not add Python or any backend until we
// explicitly start that phase"). Faking an embedding (e.g. a simple RMS/
// pitch fingerprint) would be worse than not shipping this at all: it would
// silently misidentify people with unearned confidence, which is exactly
// the failure mode this whole milestone's cascade is built to avoid ("never
// a wrong name, only a lower-confidence one").
//
// So: the storage schema, retention, and deletion are real and complete —
// ready for a real embedding model to be dropped in later — but
// matchVoiceProfile() always returns null today, and voiceProfileMatching
// stays off by default (app-settings.ts) regardless. This is the honest
// version of "shippable behind a flag": the flag exists, the schema exists,
// and turning the flag on today would still do nothing (never a false
// positive), because there is nothing behind it yet.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from '../atomic-write'

/**
 * One stored voice profile. `embedding` is typed as `number[] | null` so the
 * shape a real implementation would fill in is already correct — `null`
 * simply means "no embedding computed yet" (always true today).
 */
export interface VoiceProfile {
  id: string
  /** The contact this voice belongs to. */
  contactId: string
  /** Vector embedding once a real model exists. Always null today. */
  embedding: number[] | null
  /** Which model produced `embedding` — lets a future migration re-embed
   *  everyone if the model changes, rather than silently comparing vectors
   *  from two different embedding spaces. Always null today. */
  embeddingModel: string | null
  createdAt: string
  /** Explicit retention: biometric data should not persist indefinitely by
   *  default. Required (not optional) so a future implementation can never
   *  accidentally create a profile with no expiry — the caller must decide. */
  retainUntil: string
}

export interface VoiceProfileCreateInput {
  contactId: string
  /** ISO timestamp. Caller decides the retention window explicitly. */
  retainUntil: string
}

function profilesDir(userDataDir: string): string {
  return join(userDataDir, 'voice-profiles')
}

export async function createVoiceProfilePlaceholder(
  userDataDir: string,
  input: VoiceProfileCreateInput
): Promise<VoiceProfile> {
  const dir = profilesDir(userDataDir)
  await fs.mkdir(dir, { recursive: true })
  const profile: VoiceProfile = {
    id: randomUUID(),
    contactId: input.contactId,
    embedding: null,
    embeddingModel: null,
    createdAt: new Date().toISOString(),
    retainUntil: input.retainUntil
  }
  await writeJsonAtomic(join(dir, `${profile.id}.json`), profile)
  return profile
}

export async function listVoiceProfiles(userDataDir: string): Promise<VoiceProfile[]> {
  const dir = profilesDir(userDataDir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const results = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          return JSON.parse(await fs.readFile(join(dir, f), 'utf8')) as VoiceProfile
        } catch {
          return null
        }
      })
  )
  return results.filter((p): p is VoiceProfile => p !== null)
}

/** Deletion — required by the brief ("implement retention + deletion")
 *  regardless of whether real embeddings exist yet, since a contact record
 *  can be deleted (contacts-fs.ts's deleteContact) and any linked voice
 *  profile must go with it, not survive as an orphaned biometric record. */
export async function deleteVoiceProfile(userDataDir: string, id: string): Promise<{ ok: boolean }> {
  try {
    await fs.unlink(join(profilesDir(userDataDir), `${id}.json`))
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Purges every profile past its retainUntil — call periodically (e.g.
 *  alongside app startup), same spirit as the backup layer's scrub queue. */
export async function purgeExpiredVoiceProfiles(userDataDir: string): Promise<number> {
  const profiles = await listVoiceProfiles(userDataDir)
  const now = Date.now()
  const expired = profiles.filter((p) => Date.parse(p.retainUntil) <= now)
  await Promise.all(expired.map((p) => deleteVoiceProfile(userDataDir, p.id)))
  return expired.length
}

/**
 * The cascade's step 6 hook. Always returns null — see the file header.
 * Exists so the cascade's architecture is complete and a real embedding
 * model can be dropped in behind this one function later, without any
 * caller needing to change.
 */
export async function matchVoiceProfile(
  userDataDir: string,
  sampleAudio: ArrayBufferLike
): Promise<{ contactId: string; confidence: number } | null> {
  // Deliberately unused — no embedding model exists to compare sampleAudio
  // against yet. Kept as real parameters (not dropped) so the signature a
  // real implementation needs is already agreed.
  void userDataDir
  void sampleAudio
  return null
}
