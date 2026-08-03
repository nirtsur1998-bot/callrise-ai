import type { CallSegment } from '@renderer/features/calls/types'

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

/** Whether two segments belong to the same person. */
export function sameSpeaker(
  a: { speaker: number; channel?: number },
  b: { speaker: number; channel?: number }
): boolean {
  return speakerKey(a) === speakerKey(b)
}

/** Group a flat list of speaker-tagged words into per-speaker runs. */
export function groupWords(
  words: Array<{ speaker: number; text: string; channel?: number }>
): CallSegment[] {
  const out: CallSegment[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && sameSpeaker(last, word)) last.text = `${last.text} ${text}`
    else
      out.push(
        word.channel === undefined
          ? { speaker: word.speaker, text }
          : { speaker: word.speaker, text, channel: word.channel }
      )
  }
  return out
}

/** Append newly finalized runs onto the accumulated segments, merging when the
 *  same speaker continues. Returns a new array (does not mutate `prev`). */
export function mergeSegments(prev: CallSegment[], runs: CallSegment[]): CallSegment[] {
  const next = prev.map((s) => ({ ...s }))
  for (const run of runs) {
    const last = next[next.length - 1]
    // A gap marker is a hard boundary: speech either side of it is minutes
    // apart, so merging across one would splice two distant moments into a
    // single sentence.
    if (last && last.kind !== 'gap' && run.kind !== 'gap' && sameSpeaker(last, run)) {
      last.text = `${last.text} ${run.text}`
    } else next.push({ ...run })
  }
  return next
}
