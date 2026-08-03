import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'

/** Group a flat list of speaker-tagged words into per-speaker runs.
 *  `meta` stamps the label namespace and attribution onto every run produced,
 *  so a turn carries who-said-it from the moment it exists. */
export function groupWords(
  words: Array<{ speaker: number; text: string }>,
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
    if (last && last.speaker === word.speaker) last.text = `${last.text} ${text}`
    else
      out.push({
        speaker: word.speaker,
        text,
        ...(meta?.epoch !== undefined ? { epoch: meta.epoch } : {}),
        ...(meta?.role ? { role: meta.role(word.speaker) } : {}),
        ...(meta?.confidence !== undefined ? { confidence: meta.confidence } : {}),
        ...(meta?.unlabelled ? { unlabelled: true } : {})
      })
  }
  return out
}

/** Append newly finalized runs onto the accumulated segments, merging when the
 *  same speaker continues. Returns a new array (does not mutate `prev`).
 *
 *  Merging requires the same EPOCH as well as the same speaker number: after a
 *  reconnect Deepgram's "speaker 0" is whoever talks first on the new
 *  connection, so merging on the number alone silently glued two different
 *  people into one turn. */
export function mergeSegments(prev: CallSegment[], runs: CallSegment[]): CallSegment[] {
  const next = prev.map((s) => ({ ...s }))
  for (const run of runs) {
    const last = next[next.length - 1]
    if (last && last.speaker === run.speaker && last.epoch === run.epoch)
      last.text = `${last.text} ${run.text}`
    else next.push({ ...run })
  }
  return next
}
