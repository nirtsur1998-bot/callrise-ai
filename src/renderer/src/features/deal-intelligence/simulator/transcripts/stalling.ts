// Sample transcript (M24 Phase 1) — a stalling / dying deal, replayed
// through the Call Simulator to exercise Tier 0's negative path.
//
// The shape is deliberate: a normal-looking discovery opening (buyer asks
// two real questions in the first two minutes, rep answers fine), then the
// buyer quietly checks out. Nothing dramatic happens — no blow-up
// objection, no named competitor stealing the deal — which is the more
// common way real deals actually die. The rep, sensing the buyer has gone
// flat, does the natural but counterproductive thing: talks more to fill
// the silence, which only pushes the buyer further out. The call ends
// exactly the way stalling deals end: softer and softer commitment, no
// confirmed next step, nothing for the rep to act on except the signals
// below.
//
// Every atMs is elapsed ms since call start (see types.ts's LiveTurn doc).
// Turn-to-turn gaps are chosen deliberately, not just "realistic pacing" —
// most rep-question -> buyer-answer gaps are held under 8s specifically so
// the two intentional silence-after-question moments (noted inline) aren't
// drowned out by incidental ones. Signals deliberately engineered in:
//
//   - long-monologue: turns 25-30, six consecutive rep turns with no buyer
//     turn between them, spanning 98s (315_000ms -> 413_000ms), crossing
//     DEFAULT_CONFIG.monologueThresholdMs (90_000) on turn 30.
//   - silence-after-question: turn 17 (rep, ends '?') -> turn 18 (buyer,
//     17s later); and again turn 54 -> turn 55 (buyer, 21s later). Both
//     gaps clear DEFAULT_CONFIG.silenceAfterQuestionThresholdMs (8_000).
//   - question-drought: the buyer's last real question is turn 12
//     (124_000ms). Turn 25 (315_000ms) is the first turn at least
//     DEFAULT_CONFIG.questionDroughtMs (180_000ms) past that with
//     turnCount already well over questionDroughtMinTurns (6) — the buyer
//     never asks another question for the rest of the call, so the drought
//     never lifts.
//   - trigger-phrase (stalling): "not in the budget" (turn 39), "send me
//     some info" (turn 41), "we'll think about it" (turn 45) — three of
//     the four canonical stalling lines, all buyer-side.
//   - negative sentiment words scattered through the back half: turns 31 +
//     51 ("complicated"), 33 ("not sure"), 47 ("hesitant"), 53
//     ("concerned").
//
// No closing language anywhere (no "next steps", "contract", "sign", "move
// forward" — see tier0/callStage.ts's CLOSING_KEYWORDS, deliberately
// avoided so this fixture doesn't accidentally read as a call that closed)
// and no competitor names. The call just trails off.

import type { LiveTurn } from '../../types'

export const TRANSCRIPT: LiveTurn[] = [
  { speaker: 0, role: 'rep', atMs: 0, text: 'Hey, thanks for hopping on — can you hear me okay?' },
  {
    speaker: 1,
    role: 'other',
    atMs: 6_000,
    text: 'Yeah, I can hear you fine, thanks for setting this up.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 22_000,
    text: "Great. So today I wanted to walk through how CallRise could fit into your team's workflow, and I'd love to hear what's driving the search on your end."
  },
  { speaker: 1, role: 'other', atMs: 32_000, text: 'Sure, sounds good.' },
  {
    speaker: 0,
    role: 'rep',
    atMs: 46_000,
    text: 'Before we dive in — how many reps are you looking to roll this out to initially?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 53_000,
    text: 'Probably around fifteen to start, maybe more later if it goes well.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 67_000,
    text: "Got it, fifteen's a great starting point. What's prompting you to look at a tool like this right now?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 74_000,
    text: "Honestly, our manager wants better visibility into calls. What's the typical implementation timeline look like?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 89_000,
    text: 'Usually two to three weeks from kickoff to fully live, depending on your CRM setup.'
  },
  { speaker: 1, role: 'other', atMs: 101_000, text: "Okay, that's not too bad." },
  {
    speaker: 0,
    role: 'rep',
    atMs: 117_000,
    text: 'Not bad at all. Can you tell me a bit about your current process for tracking deals today?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 124_000,
    text: "Right now it's mostly manual notes after each call, which honestly isn't great. How does the pricing work for a team our size?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 141_000,
    text: "For fifteen seats we'd be on our team plan — I can get you exact numbers after this call once we scope things out."
  },
  { speaker: 1, role: 'other', atMs: 155_000, text: 'Okay, that makes sense.' },
  {
    speaker: 0,
    role: 'rep',
    atMs: 173_000,
    text: "Let's get into the live coaching piece, since that's usually what gets people excited. While you're on a call, it listens in real time and surfaces prompts — like if you're talking too much, or the buyer just raised a concern worth circling back to."
  },
  { speaker: 1, role: 'other', atMs: 189_000, text: 'Okay, interesting.' },
  {
    speaker: 0,
    role: 'rep',
    atMs: 204_000,
    text: 'Does that sound like something that would actually get used day to day on your team, or does it feel like another thing reps would end up ignoring?'
  },
  // 17s gap after a rep question that ends in '?' — deliberate
  // silence-after-question #1, and a flat, hedging answer once it breaks.
  {
    speaker: 1,
    role: 'other',
    atMs: 221_000,
    text: 'I mean... maybe? Hard to say without seeing it in practice, I guess.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 233_000,
    text: "No worries — picture this: you're mid-call, the buyer brings up pricing, and a small cue lets you know they raised it, in case you want to circle back before hanging up."
  },
  { speaker: 1, role: 'other', atMs: 244_000, text: "Okay, I guess that's useful." },
  {
    speaker: 0,
    role: 'rep',
    atMs: 258_000,
    text: 'It also tracks sentiment over the call, so afterward you can see roughly where things got positive or a little rocky, and it all feeds into a wrap-up report so nothing gets lost.'
  },
  { speaker: 1, role: 'other', atMs: 270_000, text: 'Right, makes sense.' },
  {
    speaker: 0,
    role: 'rep',
    atMs: 283_000,
    text: "I know that's a lot of feature rundown — happy to slow down anywhere that'd help."
  },
  { speaker: 1, role: 'other', atMs: 298_000, text: "No, it's fine — keep going." },
  // Turn 25: buyer's last real question was turn 12 at 124_000ms. This turn
  // lands at 315_000ms — past the 180_000ms drought window with the turn
  // count nowhere near the floor — so question-drought fires here. It's
  // also where the rep monologue run starts (six consecutive rep turns,
  // 25-30): the buyer going quiet is exactly what tips the rep into
  // over-explaining.
  {
    speaker: 0,
    role: 'rep',
    atMs: 315_000,
    text: "Let me make this a little more concrete, actually — there's a small heads-up display that only you as the rep see. The buyer never sees it, it's fully invisible on their side."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 333_000,
    text: "While you're talking it quietly tracks a few things in the background — how much of the call you're carrying versus the buyer, whether you've gone quiet on asking questions yourself, and whether there's been an awkward pause after something either of you said that probably deserved a follow-up."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 352_000,
    text: "Separately, it's listening for specific moments too — budget concerns, or anything that sounds like somebody else needs to weigh in before a decision gets made — and it quietly logs all of that so it doesn't get lost after we hang up."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 372_000,
    text: "None of it interrupts mid-sentence, to be clear — it's not popping alerts while you're mid-thought. It's more of a passive gauge you glance at, so if you've been talking a while, you just naturally hand the conversation back."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 393_000,
    text: "And once the call wraps, everything rolls into a summary automatically — the concerns that came up, anything either side committed to, and a rough read on engagement over time — so you're not reconstructing it all from memory later."
  },
  // Turn 30: currentRepMonologueMs hits 98_000 here (run started at
  // 315_000ms) — crosses the 90_000ms threshold, long-monologue fires.
  {
    speaker: 0,
    role: 'rep',
    atMs: 413_000,
    text: "So really, if this feels like the right fit, the plan from here is just scoping the rollout for your fifteen seats — but I want to make sure I'm actually solving the right problem for you, so jump in any time and tell me if any of this is landing, or if I'm off base for what you all need."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 428_000,
    text: "Yeah... I mean, it's a lot of moving pieces. It's kind of complicated, honestly."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 437_000,
    text: 'Totally fair — happy to keep it simple. What part feels like the most, out of everything I just went through?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 443_500,
    text: "Honestly, not sure — there's just a lot to think about on our end."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 454_500,
    text: "That's fair. Big picture — is this still something your team's actively evaluating, or has it kind of slid down the priority list?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 461_500,
    text: "It's still on the list — we're just juggling a few other things too."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 473_500,
    text: 'Makes sense. Is budget the main constraint here, or is it more about bandwidth to roll something new out right now?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 481_000,
    text: "Bit of both, if I'm honest. Budget's tight this quarter, and we don't have a ton of extra time to manage a rollout either."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 491_000,
    text: 'Understood. What would need to be true for budget to open up — is that a new-quarter thing, or a different approval process?'
  },
  // Stalling phrase #1, verbatim.
  {
    speaker: 1,
    role: 'other',
    atMs: 498_000,
    text: "Probably next quarter at the earliest. It's honestly just not in the budget right now."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 511_000,
    text: "Okay, that's really helpful to know. Even if budget isn't there today, would it be worth me sending over some numbers so you have them once planning opens up?"
  },
  // Stalling phrase #2, verbatim.
  {
    speaker: 1,
    role: 'other',
    atMs: 518_500,
    text: "Yeah, maybe. Send me some info and I'll take a look when I get a chance."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 532_500,
    text: "Will do — I'll put together a one-pager with rough pricing for fifteen seats and the rollout timeline we talked about."
  },
  { speaker: 1, role: 'other', atMs: 548_500, text: 'Sounds good, thanks.' },
  {
    speaker: 0,
    role: 'rep',
    atMs: 560_500,
    text: 'Of course. Anything else on your end I should know before we wrap up, or anything specific your manager wants addressed?'
  },
  // Stalling phrase #3, near-verbatim.
  {
    speaker: 1,
    role: 'other',
    atMs: 567_500,
    text: "Not really, I think you covered most of it. We'll think about it and probably regroup internally first."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 580_500,
    text: "Totally understand, no pressure. If it's helpful I can hop on a quick call with your manager directly too, whatever's easiest."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 598_500,
    text: "Maybe — let's see how the internal conversation goes first. I'll admit I'm a little hesitant, just given everything else going on this quarter."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 613_500,
    text: "That's completely fair. I'll send the pricing one-pager over today either way — feel free to loop me in whenever makes sense on your end."
  },
  { speaker: 1, role: 'other', atMs: 625_500, text: 'Sounds good, appreciate it.' },
  {
    speaker: 0,
    role: 'rep',
    atMs: 641_500,
    text: 'No problem. Out of curiosity, is there anything specific giving you pause, so I can make sure to address it head-on in what I send over?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 648_500,
    text: "Not one specific thing — just a lot to weigh internally right now. It's a bit of a complicated time for us to be adding anything new, honestly."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 665_500,
    text: "Totally get it, timing matters a lot with this stuff. I'll keep it low-key on my end and just check back in a couple weeks, unless you'd rather I hold off longer than that."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 679_500,
    text: "A couple weeks is probably fine. I'll be honest, I'm a little concerned about how this fits into everything else we've got going on right now."
  },
  // Rep question again, and a 21s gap before the answer — deliberate
  // silence-after-question #2, echoing turn 17/18 late in the call to show
  // the pattern is recurring, not a one-off.
  {
    speaker: 0,
    role: 'rep',
    atMs: 701_500,
    text: "That's totally fair. Before we hop off — is regrouping internally usually a couple-week thing for you all, or could it stretch out longer than that?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 722_500,
    text: 'Honestly, it varies. Could be a couple weeks, could be longer if other priorities jump the queue. Hard to say for sure right now.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 741_500,
    text: "That's fair, priorities shift. I'll follow up in a couple weeks like we said — reach out directly if anything changes before that on your end."
  },
  { speaker: 1, role: 'other', atMs: 757_500, text: 'Will do, thanks.' },
  {
    speaker: 0,
    role: 'rep',
    atMs: 807_500,
    text: 'Okay — well, like I said, no pressure at all. Take whatever time you need to regroup internally, and just reach out whenever it makes sense on your end.'
  },
  // The call trails off — no confirmed next step, nothing to close on.
  {
    speaker: 1,
    role: 'other',
    atMs: 905_500,
    text: "Yeah... okay. We'll see. Thanks for walking through everything today."
  }
]
