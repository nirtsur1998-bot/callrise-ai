// M26 Phase 4.1 — the transcript accumulator, in the main process.
//
// WHY THIS EXISTS: today the entire transcript of a live call lives in exactly
// one place — `segmentsRef`, a React ref inside a component that unmounts on
// every navigation (renderer/features/live/useTranscription.ts:148). Main's
// `Session` (main/transcription.ts:90-163) has no text field at all: it
// receives each Deepgram result, emits it, and forgets it. That single fact is
// why a renderer crash, a force-quit, or a sidebar click can lose a real
// customer conversation.
//
// PHASE 4.1 SCOPE — deliberately narrow. This module accumulates a SHADOW
// copy alongside the renderer's own. The renderer is not modified at all and
// keeps rendering from, and saving from, its own copy exactly as before, so
// nothing observable can change in this step. 4.2 journals this copy to disk;
// 4.3 makes it the source of truth and deletes the renderer's.
//
// PURE LOGIC ON PURPOSE: no Electron import, no I/O, no timers. That keeps it
// directly unit-testable — something the renderer version never was, being
// trapped inside a React hook — and it is what makes the equivalence test
// against the renderer implementation possible at all.
//
// PORTED, NOT REINVENTED. Every rule below is a deliberate copy of the
// renderer's behaviour, because 4.1's whole bar is byte-identical output. The
// research for this phase flagged the specific hazard: a second implementation
// that merges on speaker identity without epoch will mislabel every speaker
// after a reconnect, since Deepgram restarts diarization each time and main
// bumps `speakerEpoch` on every socket open. See
// transcript-accumulator.equivalence.test.ts, which runs both implementations
// over the same input and asserts the outputs match exactly.

/** Mirrors renderer/features/calls/types.ts and main/calls-fs.ts. */
export type SpeakerRole = 'rep' | 'other' | 'unknown'

export interface AccumulatedSegment {
  speaker: number
  text: string
  epoch?: number
  role?: SpeakerRole
  confidence?: number
  unlabelled?: boolean
  channel?: number
  kind?: 'gap'
}

export interface TranscriptWord {
  speaker: number
  text: string
  channel?: number
}

/** The shape main already produces at transcription.ts:663-679. */
export interface TranscriptResult {
  transcript: string
  words: TranscriptWord[]
  isFinal: boolean
  speakerEpoch: number
  speakerCertain: boolean
  minConfidence: number | null
  multichannel: boolean
}

/**
 * A segment's identity is the (channel, speaker) PAIR, never the speaker
 * alone. In mono `speaker` is a diarized guess; in multichannel it is the
 * channel index — so two segments both labelled "speaker 0" from either side
 * of a mid-call switch to buyer capture are different people.
 */
function speakerKey(seg: { speaker: number; channel?: number }): string {
  return seg.channel === undefined ? `mono/spk${seg.speaker}` : `ch${seg.channel}/spk${seg.speaker}`
}

function sameSpeaker(
  a: { speaker: number; channel?: number },
  b: { speaker: number; channel?: number }
): boolean {
  return speakerKey(a) === speakerKey(b)
}

/** Group a flat list of speaker-tagged words into per-speaker runs. `meta`
 *  stamps the label namespace and attribution onto every run produced, so a
 *  turn carries who-said-it from the moment it exists. */
function groupWords(
  words: TranscriptWord[],
  meta: {
    epoch?: number
    role?: (speaker: number) => SpeakerRole
    confidence?: number
    unlabelled?: boolean
  }
): AccumulatedSegment[] {
  const out: AccumulatedSegment[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && sameSpeaker(last, word) && last.epoch === meta.epoch) {
      last.text = `${last.text} ${text}`
    } else {
      out.push({
        speaker: word.speaker,
        text,
        ...(word.channel !== undefined ? { channel: word.channel } : {}),
        ...(meta.epoch !== undefined ? { epoch: meta.epoch } : {}),
        ...(meta.role ? { role: meta.role(word.speaker) } : {}),
        ...(meta.confidence !== undefined ? { confidence: meta.confidence } : {}),
        ...(meta.unlabelled ? { unlabelled: true } : {})
      })
    }
  }
  return out
}

/** Append newly finalized runs, merging when the same speaker continues.
 *
 *  Merging requires the same (channel, speaker) identity AND the same EPOCH.
 *  After a reconnect Deepgram's "speaker 0" is whoever talks first on the new
 *  connection, so merging on identity alone would silently glue two different
 *  people into one turn — the same reason a gap marker is a hard boundary. */
function mergeSegments(
  prev: AccumulatedSegment[],
  runs: AccumulatedSegment[]
): AccumulatedSegment[] {
  const next = [...prev]
  for (const run of runs) {
    const last = next[next.length - 1]
    if (
      last &&
      last.kind !== 'gap' &&
      run.kind !== 'gap' &&
      sameSpeaker(last, run) &&
      last.epoch === run.epoch
    ) {
      next[next.length - 1] = { ...last, text: `${last.text} ${run.text}` }
    } else {
      next.push({ ...run })
    }
  }
  return next
}

/**
 * One live call's accumulating transcript.
 *
 * Owns the epoch→rep map alongside the segments deliberately: role is decided
 * AT RECORD TIME and never revisited, so the map is an INPUT to transcript
 * construction rather than metadata about it. Splitting them is what allowed
 * one late `repSpeaker` change to retroactively relabel a whole call.
 */
export class TranscriptAccumulator {
  private segments: AccumulatedSegment[] = []
  private repByEpoch = new Map<number, number>()
  /** Set after a gap or a mono<->multichannel swap: whatever comes next is a
   *  fresh turn, never a continuation of what was interrupted. */
  private speakerBoundary = false

  /** Decide who said a turn AT THE MOMENT IT IS RECORDED. Never consulted
   *  again afterwards. */
  private resolveRole(speaker: number, epoch: number, certain: boolean): SpeakerRole {
    if (!certain) return 'unknown'
    const rep = this.repByEpoch.get(epoch)
    if (rep === undefined) return 'unknown'
    return speaker === rep ? 'rep' : 'other'
  }

  /** Feed one Deepgram result. Interim results are ignored — they re-flow into
   *  speaker turns on finalization, exactly as in the renderer. */
  ingest(payload: TranscriptResult): void {
    if (!payload.isFinal) return
    const text = payload.transcript.trim()
    const epoch = payload.speakerEpoch

    // Multichannel: the label IS the channel, so the rep is channel 0 by
    // construction. Recorded for this namespace BEFORE resolving roles.
    if (payload.multichannel && !this.repByEpoch.has(epoch)) {
      this.repByEpoch.set(epoch, 0)
    }

    const meta = {
      epoch,
      role: (speaker: number): SpeakerRole =>
        this.resolveRole(speaker, epoch, payload.speakerCertain),
      ...(payload.minConfidence !== null ? { confidence: payload.minConfidence } : {}),
      // Deepgram gave no speaker labels, so this turn's number is a fabricated
      // 0 and must never be back-filled from it later.
      unlabelled: !payload.speakerCertain
    }

    let runs: AccumulatedSegment[] = []
    if (payload.words.length > 0) {
      runs = groupWords(payload.words, meta)
    } else if (text) {
      // Rare: a final with no per-word data. Attribute it to the current
      // speaker rather than defaulting to Speaker 1 — but only within the same
      // epoch; across one, the previous label means someone else.
      const last = this.segments.at(-1)
      const lastSpeaker = last?.epoch === epoch ? last.speaker : 0
      const sameEpoch = last?.epoch === epoch
      runs = [
        {
          speaker: lastSpeaker,
          text,
          epoch,
          // Carrying a speaker across an epoch boundary is a guess, so it is
          // recorded as one rather than asserted.
          role: sameEpoch
            ? this.resolveRole(lastSpeaker, epoch, payload.speakerCertain)
            : 'unknown',
          ...(payload.minConfidence !== null ? { confidence: payload.minConfidence } : {})
        }
      ]
    }

    if (runs.length > 0) {
      if (this.speakerBoundary) {
        this.speakerBoundary = false
        this.segments = [...this.segments, ...runs]
      } else {
        this.segments = mergeSegments(this.segments, runs)
      }
    }
  }

  /** Audio that will never be transcribed. Recorded inline so the transcript
   *  never silently splices two moments minutes apart — an honest hole is far
   *  more useful than a seamless-looking lie. */
  ingestGap(marker: string): void {
    // Speaker 0 rather than a sentinel: the save-path sanitizer clamps speaker
    // ids to >= 0, so a sentinel would not survive a save anyway. Everything
    // that matters keys off `kind`.
    this.segments = [...this.segments, { speaker: 0, text: marker, kind: 'gap' }]
    this.speakerBoundary = true
  }

  /** A mono<->multichannel swap changes what a speaker label MEANS, so the
   *  next run must start a fresh turn rather than merging into the previous
   *  regime's segments. */
  markSpeakerBoundary(): void {
    this.speakerBoundary = true
  }

  /** Called once the coaching engine identifies the rep under diarization.
   *  Back-fills ONLY turns still marked 'unknown' in that same epoch —
   *  already-decided turns are immutable, and other epochs belong to other
   *  namespaces, so a speaker joining mid-call cannot retro-relabel earlier
   *  segments. */
  identifyRep(epoch: number, speaker: number): void {
    if (this.repByEpoch.get(epoch) === speaker) return
    this.repByEpoch.set(epoch, speaker)
    let changed = false
    const next = this.segments.map((s) => {
      if (s.epoch !== epoch || s.role !== 'unknown') return s
      // Unknown for the OTHER reason: Deepgram never labelled these words, so
      // s.speaker is a fabricated 0. Naming the rep 0 (the usual answer) would
      // silently assert every such turn as the rep. Leave them unattributed.
      if (s.unlabelled) return s
      changed = true
      return { ...s, role: s.speaker === speaker ? ('rep' as const) : ('other' as const) }
    })
    if (changed) this.segments = next
  }

  /** The accumulated transcript. Returns the live array reference — callers
   *  must not mutate it (every internal update is copy-on-write). */
  snapshot(): AccumulatedSegment[] {
    return this.segments
  }

  get length(): number {
    return this.segments.length
  }
}
