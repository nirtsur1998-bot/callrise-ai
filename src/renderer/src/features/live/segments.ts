import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'

/**
 * A segment's identity is the (channel, speaker) PAIR, never the speaker
 * alone. In mono, `speaker` is a diarized guess; in multichannel it is the
 * channel index — so two segments both labelled "speaker 0" from either side
 * of a mid-call switch to buyer capture are different people.
 *
 * Rendered as a string so it can key a Map or a Set without anyone
 * accidentally comparing the integer half on its own.
 */
export function speakerKey(seg: { speaker: number; channel?: number }): string {
  return seg.channel === undefined ? `mono/spk${seg.speaker}` : `ch${seg.channel}/spk${seg.speaker}`
}

/**
 * Whether two segments belong to the same person.
 *
 * NOT sufficient on its own to decide whether two RUNS may merge into one
 * turn — see mergeSegments, which also requires the same `epoch`. Deepgram
 * restarts diarization on every reconnect, so "speaker 0" on either side of a
 * reconnect can pass this (channel, speaker) check while being two different
 * people; `epoch` is the only signal that catches that case.
 */
export function sameSpeaker(
  a: { speaker: number; channel?: number },
  b: { speaker: number; channel?: number }
): boolean {
  return speakerKey(a) === speakerKey(b)
}

/** Group a flat list of speaker-tagged words into per-speaker runs.
 *  `meta` stamps the label namespace and attribution onto every run produced,
 *  so a turn carries who-said-it from the moment it exists. */
export function groupWords(
  words: Array<{ speaker: number; text: string; channel?: number }>,
  meta?: {
    epoch?: number
    role?: (speaker: number) => SpeakerRole
    confidence?: number
    unlabelled?: boolean
  }
): CallSegment[] {
  const out: CallSegment[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && sameSpeaker(last, word) && last.epoch === meta?.epoch) {
      last.text = `${last.text} ${text}`
    } else {
      out.push({
        speaker: word.speaker,
        text,
        ...(word.channel !== undefined ? { channel: word.channel } : {}),
        ...(meta?.epoch !== undefined ? { epoch: meta.epoch } : {}),
        ...(meta?.role ? { role: meta.role(word.speaker) } : {}),
        ...(meta?.confidence !== undefined ? { confidence: meta.confidence } : {}),
        ...(meta?.unlabelled ? { unlabelled: true } : {})
      })
    }
  }
  return out
}

/** Append newly finalized runs onto the accumulated segments, merging when the
 *  same speaker continues. Returns a new array (does not mutate `prev`).
 *
 *  Merging requires the same (channel, speaker) identity AND the same EPOCH:
 *  after a reconnect Deepgram's "speaker 0" is whoever talks first on the new
 *  connection, so merging on identity alone would silently glue two different
 *  people into one turn — the same reason a gap marker is also a hard
 *  boundary, since speech either side of one can be minutes apart. */
export function mergeSegments(prev: CallSegment[], runs: CallSegment[]): CallSegment[] {
  const next = prev.map((s) => ({ ...s }))
  for (const run of runs) {
    const last = next[next.length - 1]
    if (
      last &&
      last.kind !== 'gap' &&
      run.kind !== 'gap' &&
      sameSpeaker(last, run) &&
      last.epoch === run.epoch
    ) {
      last.text = `${last.text} ${run.text}`
    } else {
      next.push({ ...run })
    }
  }
  return next
}
