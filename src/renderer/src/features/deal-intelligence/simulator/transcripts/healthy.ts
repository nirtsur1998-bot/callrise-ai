// "Healthy" transcript fixture (M24 — testing requirements) — a discovery
// call that's going WELL: balanced airtime, the buyer asking real questions
// on a healthy cadence, no objection language, and a clean run through
// opening -> discovery -> demo-pitch -> closing. This is the inverse of a
// fixture built to trip alarms — it exists so tests can assert Tier 0 stays
// QUIET (no long-monologue, no silence-after-question, no question-drought)
// on a call that doesn't deserve a nudge, which is just as important to
// cover as the failure paths.
//
// The timing was hand-tuned against several load-bearing constraints that
// aren't visible just from reading the dialogue, so don't reshuffle turns or
// re-time them without re-checking these against tier0/*.ts:
//   - Every rep turn ending in '?' is followed by the NEXT turn (whoever
//     speaks) within <8s — silenceGap.ts's pendingRepQuestion check fires off
//     the very next turn regardless of who it's from, not just the buyer's
//     reply, so this has to hold for literally every rep question here.
//   - The one back-to-back rep run (the two consecutive rep entries walking
//     through the "5 AM sick call" scenario, ~7 minutes in) spans well under
//     the 90s monologue threshold — included deliberately so the fixture
//     exercises detectMonologue's accumulation path, not just its
//     always-zero case from strict alternation.
//   - The buyer's own questions (there are several) never let
//     lastBuyerQuestionAtMs go stale past ~2 minutes, comfortably inside
//     questionDrought's 3-minute window.
//   - No text anywhere matches mentions.ts's BUILT_IN_TRIGGER_PHRASES or
//     callStage.ts's CLOSING_KEYWORDS before the intended closing beat late
//     in the call — "single sign-on" was deliberately written as "SSO" for
//     exactly this reason, since CLOSING_KEYWORDS's bare 'sign' would
//     otherwise match inside "sign-on" and flip callStage to 'closing' (a
//     one-way door) eight minutes early.
//
// atMs is elapsed ms since call start, per LiveTurn's contract — not
// wall-clock. Speaker 0/'rep' is the rep throughout; speaker 1/'other' is
// the buyer.

import type { LiveTurn } from '../../types'

export const TRANSCRIPT: LiveTurn[] = [
  {
    speaker: 0,
    role: 'rep',
    atMs: 0,
    text: "Hey Casey, thanks for making time this week — how's everything going on your end?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 7000,
    text: "Good, thanks! Things are busy as always, but I'm glad we finally got this on the calendar — it's been a hectic few weeks trying to find a good time."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 24000,
    text: 'Glad to hear it. Before we dive in, mind if I ask a couple quick questions about your team so I can tailor the conversation?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 29000,
    text: 'Sure, happy to — go ahead and ask away.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 46000,
    text: "Great. So today I'd love to hear how your operations team currently handles scheduling, and then I can show you where Meridian Flow might fit in. Sound good?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 52000,
    text: "Sounds good to me — happy to give you the full picture of where we're at."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 70000,
    text: 'Perfect. So walk me through it — how many people are on your operations team right now?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 76000,
    text: "We've got about twenty-two people across three shifts, plus a handful of dispatchers who coordinate with drivers — is that a typical size for the teams you usually work with?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 97000,
    text: 'Twenty-two across three shifts is a decent-sized team to coordinate. What are you using today to build and manage those schedules?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 104000,
    text: "Honestly it's a mix of a shared spreadsheet and a lot of text messages. It works, but it's held together with duct tape at this point."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 126000,
    text: "That's really common actually. When something changes last-minute, like a driver calling in sick, how does that update actually get to everyone?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 132000,
    text: "Usually a group text, and honestly sometimes people miss it. We've had a couple of shifts go uncovered because someone didn't see the message in time."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 155000,
    text: 'That sounds stressful for everyone involved. Is there a single source of truth once a shift does get filled, or is it scattered across the spreadsheet and the texts?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 162000,
    text: "It's pretty scattered honestly. My lead dispatcher, Marcus, basically holds a lot of it in his head at this point, which makes me nervous when he's out."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 185000,
    text: "That's exactly the kind of single-point-of-failure risk we hear about a lot. Can you tell me more about onboarding — when a new dispatcher joins, how long does it typically take them to get comfortable running scheduling on their own?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 191000,
    text: "Honestly, it takes a few weeks. There's no real documented process, so it's mostly shadowing Marcus and figuring it out. Do most of your customers struggle with that same ramp-up problem?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 214000,
    text: "That's a great data point. Before I get into that, how does scheduling connect to the other systems you use — payroll, dispatch, anything like that?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 220000,
    text: "Right now nothing's connected. We manually copy hours from the spreadsheet into our payroll system every other Friday, which takes my ops coordinator half a day."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 243000,
    text: 'Half a day every pay period adds up fast. Integration with payroll is actually one of the areas where we can plug in pretty directly. What about the dispatch side — do you use a separate tool for routing drivers?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 249000,
    text: "We use a routing tool for the drivers themselves, yeah. It's a different system, and it doesn't talk to our scheduling spreadsheet at all right now."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 273000,
    text: "Okay, that's helpful context. What's driving the timeline on fixing this — is there a specific event pushing it?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 279000,
    text: "We're actually trying to get something in place before peak season ramps up. Our goal is to go live by end of Q3 so the new process is second nature before things get busy."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 301000,
    text: 'Good to know — peak season is exactly the kind of deadline that makes this worth prioritizing now. Roughly how many schedule changes would you say happen in a typical week?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 308000,
    text: 'Probably quite a few — twenty to thirty changes a week, easily. Sick calls, shift swaps, people picking up extra hours. How does the system handle it when two people want to swap shifts at the same time?'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 331000,
    text: "Twenty to thirty a week is a lot to manage over text and spreadsheets — and yes, swaps happen right in the same interface, so nobody's stuck coordinating over text. Actually, I'd love to just show you how this looks inside Meridian Flow, if that works?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 337000,
    text: "Yeah, let's do it — I'd love to see it in action."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 359000,
    text: 'Awesome, let me show you the scheduling board first — this is the main view your dispatchers would live in day to day.'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 369000,
    text: "Oh nice, I like that it shows the shifts as a timeline instead of just a list. That's already way clearer than our spreadsheet."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 393000,
    text: "Right, and if Marcus needs to swap two people, he just drags and drops — it recalculates hours and flags overtime automatically. Let me walk you through what happens when someone calls in sick, since that's the scenario you mentioned earlier."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 402000,
    text: "Okay, walk me through it — that's honestly our biggest pain point most weeks."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 425000,
    text: "Say your driver texts Marcus at 5 AM that they're out sick. He opens the app, marks that shift open, and the system automatically suggests the next-best person based on their availability and hours already worked this week."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 444000,
    text: "That suggestion also takes into account who's already close to overtime, so you're not accidentally creating a payroll problem while you're just trying to cover a shift."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 451000,
    text: "Honestly, I'm impressed — half the time we accidentally push someone into overtime without noticing until payroll flags it after the fact. Does the system warn Marcus before he approves something that pushes into overtime, or just after?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 474000,
    text: "Exactly — and once you're onboarded, most teams tell us that overtime creep basically disappears within the first month. Want me to show you how the payroll integration works, since that was the half-day task you mentioned?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 480000,
    text: "Yes, let's see that part — that's honestly the piece I'm most curious about."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 504000,
    text: 'Perfect. Once a shift is approved, Meridian Flow pushes the finalized hours straight into your payroll system overnight — no more manual copy-paste on Fridays.'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 511000,
    text: 'That would save my coordinator so much time. This is great, honestly — I can already picture how much smoother Friday would be.'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 534000,
    text: "That's exactly the reaction we hope for. Let's talk pricing for a minute, since I know that's usually top of mind — can I ask roughly what range you were expecting to invest in something like this?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 541000,
    text: "Sure — we do have some budget set aside for this. I'd guess somewhere between forty and fifty thousand for the year, depending on what's included."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 563000,
    text: "That's right in line with where most teams your size land. Let me show you the actual pricing tiers so you can see what's included at that level."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 572000,
    text: 'Okay, that breakdown makes sense — I like that onboarding support is included instead of being a separate add-on. Is there a limit on how many people can go through onboarding at once?'
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 595000,
    text: "It is, yeah — every plan includes onboarding, plus you'd get a dedicated integration specialist for the payroll and routing connections during your first month."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 602000,
    text: "Having a dedicated person for that first month would be huge, especially with peak season timing. That's genuinely helpful to know upfront."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 625000,
    text: 'Glad that lands well. Out of curiosity, how does your team currently handle data security around scheduling info — is that something IT weighs in on for tools like this?'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 632000,
    text: "IT usually does a review for anything new, yeah, but it's mostly just a checklist — SSO, data encryption, that kind of thing."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 654000,
    text: "That's easy — we support SSO out of the box, and everything's encrypted both in transit and at rest, so that checklist should go smoothly. What about support — if Marcus hits a snag at 5 AM when a driver calls in sick, who does he reach?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 661000,
    text: "Right now it's just him figuring it out, or texting me if it's bad enough. There's no real support line for our current setup since it's just a spreadsheet."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 684000,
    text: "We've got a support line covering the early morning hours specifically, because that's when most scheduling emergencies happen, so Marcus wouldn't be on his own for that."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 691000,
    text: "That's genuinely great to hear — that early morning window is exactly when things go sideways for us most often. Is that early support line included in every plan, or is it an upgrade?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 714000,
    text: "Makes sense given the shift start times. Once you're up and running, is there a specific person on your team who'd want the most hands-on training, or would it mostly be you and Marcus?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 720000,
    text: "It'd mainly be me and Marcus at first, and then we'd roll it out to the other two dispatchers once we're comfortable with it ourselves."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 743000,
    text: "That's a smart rollout plan — start small, get confident, then expand. What about reporting — does anyone above you, like a regional manager, ask for visibility into coverage or overtime trends?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 750000,
    text: "Yeah, my director asks for a monthly overtime summary, which right now I basically build by hand in a spreadsheet every month. It takes me a couple hours I'd rather not spend on it."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 773000,
    text: "That's exactly the kind of report Meridian Flow generates automatically — a couple clicks instead of building it from scratch. Does a monthly cadence match what your director wants, or would more frequent visibility be useful?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 779000,
    text: "Monthly's what they ask for, but honestly having it available anytime would be great in case something comes up mid-month."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 802000,
    text: "That's easy — the dashboard updates in real time, so you'd always have current numbers whenever you need them, not just once a month."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 809000,
    text: "That's really useful. Between the scheduling board, the payroll piece, and the reporting, this actually covers basically everything on my wishlist. Is there anything most teams like ours end up wishing they'd asked about upfront?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 834000,
    text: "That's great to hear. Besides you and Marcus, is there anyone else who'd want a say before your team commits to something like this?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 840000,
    text: "It's really just me for something at this level — I have the budget and the authority to make the call, so once I'm comfortable, we can move fast."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 864000,
    text: "That definitely simplifies things on our side. Let's talk through what the next few weeks could look like if you decided to move ahead."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 871000,
    text: "I'd love that. Honestly, the more I hear, the more confident I feel about this — I think we're ready to figure out next steps."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 894000,
    text: "I love that — let's do this. I'll put together a proposal today covering the setup, the payroll and routing integration work, and onboarding for you and Marcus, and get it to you by tomorrow."
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 901000,
    text: "That sounds perfect. Send it over and I'll get it in front of our finance team so we can move forward quickly. Should I loop in anyone from your side on the proposal email?"
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 924000,
    text: "Sounds like a plan. I'll have that proposal in your inbox by tomorrow morning, and we can set up a quick call once your finance team has had a chance to look at it. Anything else on your end before we wrap up today?"
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 931000,
    text: "I don't think so — this was really helpful, thank you. I'm excited to get this rolling."
  },
  {
    speaker: 0,
    role: 'rep',
    atMs: 954000,
    text: 'Likewise, thanks for walking me through all of that context — it makes this a lot easier to scope correctly. Talk soon, Casey.'
  },
  {
    speaker: 1,
    role: 'other',
    atMs: 964000,
    text: 'Sounds great — talk soon! Thanks again, Jordan.'
  }
]
