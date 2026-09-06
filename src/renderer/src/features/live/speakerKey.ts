/**
 * A segment's identity is the (channel, speaker) PAIR, never the speaker
 * alone. In mono, `speaker` is a diarized guess; in multichannel it is the
 * channel index — so two segments both labelled "speaker 0" from either side
 * of a mid-call switch to buyer capture are different people.
 *
 * Rendered as a string so it can key a Map or a Set without anyone
 * accidentally comparing the integer half on its own.
 *
 * Moved out of segments.ts on 2026-09-06 (taxonomy species 12): that file is
 * the pre-4.3 oracle, frozen by its header, and declares that nothing in the running app calls
 * it — which was untrue by exactly this function, imported by three
 * production files. Now the header is true and a test keeps it so
 * (src/__tests__/frozen-modules-have-no-production-callers.test.ts).
 */
export function speakerKey(seg: { speaker: number; channel?: number }): string {
  return seg.channel === undefined ? `mono/spk${seg.speaker}` : `ch${seg.channel}/spk${seg.speaker}`
}
