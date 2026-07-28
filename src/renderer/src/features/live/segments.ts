import type { CallSegment } from '@renderer/features/calls/types'

/** Group a flat list of speaker-tagged words into per-speaker runs. */
export function groupWords(words: Array<{ speaker: number; text: string }>): CallSegment[] {
  const out: CallSegment[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && last.speaker === word.speaker) last.text = `${last.text} ${text}`
    else out.push({ speaker: word.speaker, text })
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
    if (last && last.kind !== 'gap' && run.kind !== 'gap' && last.speaker === run.speaker) {
      last.text = `${last.text} ${run.text}`
    } else next.push({ ...run })
  }
  return next
}
