// M25 Sales Brain — backfill: seeds memory from data that already existed
// BEFORE Sales Brain was ever turned on. Without this, turning the feature
// on only starts learning from the NEXT call — every past call, every KYC
// field already filled in on a contact, every deal already tracked, would
// simply be invisible to it. Explicitly user-triggered (never automatic on
// enabling the flag — see backfill-ipc.ts), since scanning every past call
// through the extraction AI can be slow and, on a real BYO-key account,
// isn't free.
//
// Two very different costs, kept as separate opt-in flags:
//   - Contacts and deals are already STRUCTURED data (named fields the rep
//     typed into a form) — mapped directly into memories with NO AI call at
//     all. Fast, free, and source: 'user_stated' (the rep IS the source —
//     they entered it themselves), so it's trusted immediately, same as
//     the onboarding interview's answers.
//   - Past calls need the SAME AI extraction pass a live call gets
//     (extraction.ts) — one AI call per call, run through the exact same
//     verification/consolidation pipeline as always. This is the slow,
//     costs-real-API-usage part, kept as its own toggle.
import { getCall, listCalls } from '../calls-fs'
import { listContacts, type Contact } from '../contacts-fs'
import { listDeals, type Deal } from '../deals-fs'
import { extractMemoriesFromCall } from './extraction'
import { consolidateNewCandidate, runLightConsolidation } from './consolidation'
import { clientScope, type MemoryCandidate, type MemoryEvidence, type MemoryScope } from './types'
import { isSalesBrainEnabled } from '../app-settings'
import type Database from 'better-sqlite3'

/** BUG-046 — backfill can run long enough that a rep turns Sales Brain off,
 *  or excludes a specific call, WHILE it's still going. backfill-ipc.ts's own
 *  isSalesBrainEnabled() check only gates whether the job is allowed to
 *  START; it's not re-checked once the job is running. Per memory-hooks.ts's
 *  own rule, this is a permission, not scope, so it must be read fresh on
 *  every iteration rather than trusted from the moment the job began.
 *  Thrown, not silently returned, so the existing catch below surfaces the
 *  stop instead of reporting a misleading 'done'. */
class BackfillHaltedError extends Error {}

function assertStillEnabled(): void {
  if (!isSalesBrainEnabled()) {
    throw new BackfillHaltedError('Sales Brain was turned off — import stopped partway through.')
  }
}

export interface BackfillProgress {
  running: boolean
  stage: 'idle' | 'contacts' | 'deals' | 'calls' | 'done' | 'error'
  processed: number
  total: number
  lastError?: string
}

function fieldFact(contactId: string, label: string, value: string | number | undefined): MemoryCandidate | null {
  if (value === undefined || value === null || value === '') return null
  const evidence: MemoryEvidence = {
    type: 'transcript',
    callId: `backfill:contact:${contactId}`,
    quote: `${label}: ${value}`
  }
  return {
    scope: clientScope(contactId),
    category: 'client-fact',
    statement: `${label}: ${value}`,
    evidence: [evidence],
    confidence: 0.9,
    importance: 5,
    source: 'user_stated'
  }
}

/** Every populated KYC/deal-context field on a contact, mapped 1:1 to a
 *  client-scope fact — no AI needed, this is already exactly the shape a
 *  memory statement wants (a short, factual, labeled line). Deliberately
 *  narrow to fields that are genuinely durable facts about the client
 *  (never `notes`/`personalNotes`/`briefingNotes` — those are free text the
 *  rep already reads directly elsewhere, and dumping them in unfiltered
 *  risks exactly the "personal life" category spec section 5 forbids
 *  auto-extraction from; here it's technically user_stated, not auto, but
 *  the same spirit applies — only durable BUSINESS-relevant fields). */
function contactToCandidates(contact: Contact): MemoryCandidate[] {
  return [
    fieldFact(contact.id, 'Industry', contact.industry),
    fieldFact(contact.id, 'Company size', contact.companySize),
    fieldFact(contact.id, 'Decision authority', contact.decisionAuthority),
    fieldFact(contact.id, 'Other stakeholders', contact.otherStakeholders),
    fieldFact(contact.id, 'Budget indication', contact.budgetIndication),
    fieldFact(contact.id, 'Timeline', contact.timeline),
    fieldFact(contact.id, 'Known competitors in play', contact.competitors),
    fieldFact(contact.id, 'Known objections', contact.knownObjections),
    fieldFact(contact.id, 'Current tooling', contact.currentTooling),
    fieldFact(contact.id, 'Communication style', contact.communicationStyle)
  ].filter((c): c is MemoryCandidate => c !== null)
}

function dealToCandidates(deal: Deal): MemoryCandidate[] {
  return [
    fieldFact(deal.contactId, 'Deal value', deal.value !== undefined ? `$${deal.value.toLocaleString()}` : undefined),
    fieldFact(deal.contactId, 'Expected close date', deal.expectedCloseDate)
  ].filter((c): c is MemoryCandidate => c !== null)
}

export interface BackfillOptions {
  includeContacts: boolean
  includeDeals: boolean
  /** The slow, AI-cost-incurring part — off by default in the UI (see
   *  backfill-ipc.ts), opted into explicitly. */
  includeCalls: boolean
  callsDir: string
  contactsDir: string
  dealsDir: string
}

/** Runs the backfill, reporting progress via `onProgress` after each item —
 *  the caller (backfill-ipc.ts) polls a module-level snapshot of this
 *  rather than the renderer subscribing to a stream, same simplicity
 *  tradeoff as everywhere else "progress" is surfaced in this app.
 *  Never throws — a single item's failure (one call's extraction erroring)
 *  is skipped, not fatal to the whole run, same as every other extraction
 *  call site's own best-effort contract. The one exception reported through
 *  the SAME 'error' stage rather than skipped: Sales Brain being turned off
 *  mid-run (assertStillEnabled) — that one must stop the whole backfill, not
 *  just the current item, so it's surfaced rather than swallowed. */
export async function runBackfill(
  db: Database.Database,
  opts: BackfillOptions,
  onProgress: (p: BackfillProgress) => void
): Promise<void> {
  const touchedScopes = new Set<MemoryScope>()

  try {
    assertStillEnabled()

    if (opts.includeContacts) {
      const contacts = await listContacts(opts.contactsDir)
      onProgress({ running: true, stage: 'contacts', processed: 0, total: contacts.length })
      for (let i = 0; i < contacts.length; i++) {
        assertStillEnabled()
        for (const candidate of contactToCandidates(contacts[i])) {
          await consolidateNewCandidate(db, candidate)
          touchedScopes.add(candidate.scope)
        }
        onProgress({ running: true, stage: 'contacts', processed: i + 1, total: contacts.length })
      }
    }

    if (opts.includeDeals) {
      const deals = await listDeals(opts.dealsDir)
      onProgress({ running: true, stage: 'deals', processed: 0, total: deals.length })
      for (let i = 0; i < deals.length; i++) {
        assertStillEnabled()
        for (const candidate of dealToCandidates(deals[i])) {
          await consolidateNewCandidate(db, candidate)
          touchedScopes.add(candidate.scope)
        }
        onProgress({ running: true, stage: 'deals', processed: i + 1, total: deals.length })
      }
    }

    if (opts.includeCalls) {
      const calls = await listCalls(opts.callsDir)
      const withTranscripts = calls.filter((c) => c.hasSummary || c.hasCoaching || c.durationMs > 0)
      onProgress({ running: true, stage: 'calls', processed: 0, total: withTranscripts.length })
      for (let i = 0; i < withTranscripts.length; i++) {
        assertStillEnabled()
        try {
          const full = await getCall(opts.callsDir, withTranscripts[i].id)
          // Fresh per-call read, same as memory-hooks.ts's runMemoryExtractionForCall —
          // a rep who marked this call "don't learn from this" must be honoured here too,
          // not just on the live-call path.
          if (full?.segments?.length && !full.salesBrainExcluded) {
            const candidates = await extractMemoriesFromCall(full.segments, full.id, full.contactId ?? null)
            for (const candidate of candidates) {
              await consolidateNewCandidate(db, candidate)
              touchedScopes.add(candidate.scope)
            }
          }
        } catch {
          /* one call's extraction failing must never abort the whole backfill */
        }
        onProgress({ running: true, stage: 'calls', processed: i + 1, total: withTranscripts.length })
      }
    }

    for (const scope of touchedScopes) {
      await runLightConsolidation(db, scope)
    }

    onProgress({ running: false, stage: 'done', processed: 0, total: 0 })
  } catch (e) {
    onProgress({
      running: false,
      stage: 'error',
      processed: 0,
      total: 0,
      lastError: e instanceof Error ? e.message : String(e)
    })
  }
}
