// Authority/procurement-heavy sample transcript (M24 simulator fixture).
//
// Built to exercise the one path the other two sample transcripts don't:
// the 'authority' objection type, via the buyer repeatedly deferring to
// other stakeholders ("need to check with", "not my decision", "need
// approval from", "need to run this by" — the built-in authority phrases in
// tier0/mentions.ts), plus a clean budget mention and a timeline mention.
// Turns strictly alternate rep/buyer with gaps capped well under 8s after
// every rep question and no run of consecutive same-role turns, so none of
// the PACING detectors (monologue, silence-after-question, talk-ratio-skewed,
// question-drought) fire and muddy a transcript that's only supposed to be
// about the mentions/objection-inference path.

import type { LiveTurn } from '../../types'

export const TRANSCRIPT: LiveTurn[] = [
  {
    speaker: 0,
    role: 'rep',
    atMs: 0,
    text: "Thanks for hopping on — I know you're juggling a lot this week. To start, can you walk me through who's typically involved when your team brings on a new tool like this?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 6_000,
    text: "Sure. I run point on evaluation, but honestly I'd need to check with our IT director before anything moves forward — he owns the final call on anything touching our systems."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 30_000,
    text: "Good to know up front. What does he tend to care most about when he's reviewing something like this?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 36_000,
    text: 'Security posture mostly, and whether it plays nicely with what we already have. He moves fast once he trusts something, slow if he does not.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 60_000,
    text: "That's useful context. Beyond him, is there anyone else who typically weighs in before a purchase like this gets approved?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 66_000,
    text: 'Finance, for sure, on anything over a few thousand a year. And honestly, approving new vendors is not my decision at all — I just scope things and pass a recommendation up.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 90_000,
    text: 'Totally fair — most teams work that way. What does the budget picture look like for something in this category this year?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 96_000,
    text: "We've got roughly $18,000 budgeted for tools like this across the year, split across a couple of initiatives."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 120_000,
    text: "That's workable for what we'd be talking about. Let me show you how the workspace actually looks day to day, since that's usually the easiest way to get a feel for it."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 144_000,
    text: 'Sure, go ahead. Does this integrate with our existing ticketing system, or would that need custom work?'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 168_000,
    text: "It integrates natively, no custom work needed on your side. Here's the automation piece running against a live example."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 192_000,
    text: 'That actually looks really clean. My team would probably like this a lot more than what we have now.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 216_000,
    text: "Glad it's landing well. What's the timeline looking like if this moves forward — is there a date you're working against?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 222_000,
    text: "We'd want something in place by end of Q2, before our busy season starts. That's more of an internal goal than a hard deadline though."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 246_000,
    text: 'Good target to aim for. If I put together something formal, who would actually need to see it before it can move — just IT, or finance too?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 252_000,
    text: "Both, honestly. I'd need approval from IT on the technical side, and finance would need to approve the spend separately — they don't always move in parallel."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 276_000,
    text: "That's helpful to know so we can plan around it instead of being surprised by it later. Would a short technical brief for your IT director help move things along?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 282_000,
    text: 'That would help a lot, actually. I could forward that directly rather than trying to summarize it myself secondhand.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 306_000,
    text: "I'll put that together this week. Is there anything specific he tends to ask about that I should get ahead of?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 312_000,
    text: "Data residency, mostly, and how access controls work across teams. If that's covered clearly he usually moves quickly after that."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 336_000,
    text: "Noted — I'll make sure both of those are front and center in what I send over. Once he's reviewed it, what's the next step on your end?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 342_000,
    text: "I'd need to run this by him directly first, then loop finance in once he's comfortable. I honestly can't promise a date until he's seen it."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 366_000,
    text: 'Completely understood — I would rather build in the real approval steps now than promise a timeline we cannot actually hit.'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 372_000,
    text: 'I appreciate that. This has been genuinely useful, and I think once IT is comfortable, the rest should move fairly quickly on my side.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 396_000,
    text: "Sounds good. I'll send the technical brief today, and we can regroup once your director has had a chance to look it over."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 402_000,
    text: "Perfect, that works. I'll flag it to him as soon as it lands so it does not just sit in his inbox."
  }
]
