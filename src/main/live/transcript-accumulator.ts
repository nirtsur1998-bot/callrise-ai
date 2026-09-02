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

/** BUG-164 — how far back to look for the loopback copy of an incoming mic
 *  segment. Both copies of an echo arrive together (measured at a 0ms offset),
 *  so this only needs to span the jitter between the two channels' finals. */
const ECHO_LOOKBACK = 8

/** Below this, an identical string on both channels is more likely to be two
 *  people saying "yes" than an echo. */
const ECHO_MIN_CHARS = 24

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

    // Both orders, because on a real machine the microphone final lands first.
    this.dropEarlierMicEcho(runs)
    runs = this.dropMicEcho(runs)

    if (runs.length > 0) {
      if (this.speakerBoundary) {
        this.speakerBoundary = false
        this.segments = [...this.segments, ...runs]
      } else {
        this.segments = mergeSegments(this.segments, runs)
      }
    }
  }

  /** BUG-164 — the rep's microphone hearing the OTHER PARTY through their
   *  speakers, and the transcript recording it as something the rep said.
   *
   *  Measured on a real call: 38% of segments byte-identical on both channels
   *  at a ZERO millisecond offset. `echoCancellation: true` is requested and
   *  cannot help — Chromium only cancels what CHROMIUM rendered, and the far
   *  end is played by Zoom/Teams, a different process entirely.
   *
   *  WHY DROPPING THE CHANNEL-0 COPY IS SAFE, and not a coin flip. Channel 0
   *  is the microphone; channel 1 is the system loopback, which carries only
   *  what the machine PLAYS. The rep's own voice is never played back by the
   *  machine, so it can never appear on channel 1. Text present on BOTH
   *  channels therefore came from the far end without exception, and the
   *  channel-0 copy is always the echo. There is no symmetric case to get
   *  wrong.
   *
   *  Why it matters more than a messy transcript: talk-to-listen ratio is a
   *  headline coaching metric with a health band ("your share of words ·
   *  healthy 40-55%"), and the echo inflates the rep's share by construction.
   *  A rep on speakers was being told they talk too much when they do not.
   *
   *  Counted, not just dropped — `echoDropped` is how we find out how common
   *  this is in the field rather than guessing from one machine. */
  private echoDropped = 0

  private static echoKey(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  }

  /** The OTHER ORDER, and the one that actually happens on a real machine.
   *
   *  dropMicEcho only fires when the loopback copy is already stored. Driving
   *  a real call showed the microphone's final arrives FIRST — the mic is
   *  local, the loopback lags — so there was nothing to match against and the
   *  dedupe was a no-op in the field while passing every unit test. (The unit
   *  test that encoded the mic-first order asserted the mic copy is KEPT,
   *  which is exactly the case this handles.)
   *
   *  So when a loopback run lands, look BACK for a mic segment saying the same
   *  thing and remove that instead. Only ever removes channel 0 — a loopback
   *  segment is never a candidate, for the same reason the whole fix is safe. */
  private dropEarlierMicEcho(runs: AccumulatedSegment[]): void {
    const incoming = runs.filter((r) => r.kind !== 'gap' && r.channel === 1)
    if (incoming.length === 0) return
    const keys = incoming.map((r) => TranscriptAccumulator.echoKey(r.text)).filter((k) => k.length >= ECHO_MIN_CHARS)
    if (keys.length === 0) return
    const cutoff = Math.max(0, this.segments.length - ECHO_LOOKBACK)
    const next: AccumulatedSegment[] = []
    let dropped = false
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]
      if (i >= cutoff && seg.kind !== 'gap' && seg.channel === 0) {
        const k = TranscriptAccumulator.echoKey(seg.text)
        if (k.length >= ECHO_MIN_CHARS && keys.some((inc) => inc === k || inc.endsWith(' ' + k))) {
          this.echoDropped += 1
          dropped = true
          continue
        }
      }
      next.push(seg)
    }
    if (dropped) this.segments = next
  }

  private dropMicEcho(runs: AccumulatedSegment[]): AccumulatedSegment[] {
    if (runs.length === 0) return runs
    // Only the recent tail can be an echo of the same moment: both copies
    // arrive together (0ms apart when measured), so an unbounded search would
    // only add ways to delete a genuine repetition minutes later.
    const recent = this.segments.slice(-ECHO_LOOKBACK)
    const loopbackText = recent
      .filter((s) => s.channel === 1 && s.kind !== 'gap')
      .map((s) => TranscriptAccumulator.echoKey(s.text))
    if (loopbackText.length === 0) return runs
    const kept = runs.filter((r) => {
      if (r.kind === 'gap' || r.channel !== 0) return true
      const key = TranscriptAccumulator.echoKey(r.text)
      // A very short utterance ("yes", "okay") genuinely gets said by both
      // people seconds apart. Only dedupe something long enough that the
      // coincidence is not plausible.
      if (key.length < ECHO_MIN_CHARS) return true
      // ENDS-WITH, not equality. Dropping an echo makes the surrounding
      // loopback runs consecutive, so mergeSegments joins them and the stored
      // loopback text keeps GROWING — by the second echo it reads
      // "<first line> <second line>" while the mic still delivers one line at
      // a time. Equality matched the first echo and missed every one after it.
      // A suffix match is still safe for the same reason the whole fix is: the
      // rep's voice cannot reach channel 1, so anything of theirs found inside
      // a loopback segment came from the far end.
      if (!loopbackText.some((t) => t === key || t.endsWith(' ' + key))) return true
      this.echoDropped += 1
      return false
    })
    return kept
  }

  /** How many microphone-echo segments were dropped this session. Read by the
   *  save path so the rate can be measured across real calls instead of
   *  inferred from one machine. */
  getEchoDroppedCount(): number {
    return this.echoDropped
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
