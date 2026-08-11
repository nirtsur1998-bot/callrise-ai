// The starter battlecard library (§4.4).
//
// The library is the head of this feature and an authoring UI is the tail:
// a rep who opens the app to thirty working triggers has something useful on
// their first call, where a rep who opens it to an empty authoring screen has
// homework. So this ships curated rather than blank.
//
// Two rules held throughout:
//
//   The `say` line has to be READABLE MID-CALL. If the rep has to stop
//   listening to parse it, it has cost them the conversation it was meant to
//   save. One sentence, no clauses stacked up, no jargon.
//
//   Patterns favour precision over recall. A card that fires when it should
//   not is worse than one that stays quiet: it trains the rep to ignore the
//   rail, and once ignored the whole surface is dead. So phrases are the ones
//   people actually say, not every phrasing they could conceivably use.
//
// Competitor names are deliberately generic placeholders — a real library is
// per-company, and inventing rivals for a product we know nothing about would
// produce cards that are confidently wrong.

import type { Trigger } from './match'

function t(
  id: string,
  patterns: string[],
  label: string,
  say: string,
  category: Trigger['card']['category']
): Trigger {
  return { id, patterns, card: { id, label, say, category } }
}

export const STARTER_TRIGGERS: Trigger[] = [
  // --- Price and budget -----------------------------------------------------
  t(
    'price-too-expensive',
    ['too expensive', 'too much money', 'quite pricey', 'too pricy', 'too pricey'],
    'Too expensive',
    'Ask what they are comparing it to before defending the number.',
    'pricing'
  ),
  t(
    'price-no-budget',
    ['no budget', 'budget is tight', 'not in the budget', 'out of budget'],
    'No budget',
    'Budget follows priority — find out what it is competing against.',
    'pricing'
  ),
  t(
    'price-discount',
    ['any discount', 'better price', 'come down on price', 'sharpen your pencil'],
    'Discount ask',
    'Trade, never give: what can they commit to in return?',
    'pricing'
  ),
  t(
    'price-cheaper-elsewhere',
    ['cheaper elsewhere', 'cheaper option', 'less expensive option', 'found it cheaper'],
    'Cheaper elsewhere',
    'Ask what is included in that price — compare scope, not headline.',
    'pricing'
  ),
  t(
    'price-next-year',
    ['next budget cycle', 'next fiscal', 'next quarter budget', 'new budget year'],
    'Budget cycle',
    'Ask what waiting costs them between now and then.',
    'pricing'
  ),

  // --- Timing ---------------------------------------------------------------
  t(
    'timing-not-now',
    ['not right now', 'bad timing', 'not a good time', 'maybe later in the year'],
    'Timing',
    'Ask what would have to change for it to be the right time.',
    'objection'
  ),
  t(
    'timing-circle-back',
    ['circle back', 'touch base later', 'revisit in a few months', 'check back in'],
    'Circle back',
    'Pin a date and a reason now, or this never happens.',
    'process'
  ),
  t(
    'timing-too-busy',
    ['too busy', 'swamped right now', 'a lot on our plate'],
    'Too busy',
    'Ask what it would take off their plate, not what it adds.',
    'objection'
  ),

  // --- Authority and process ------------------------------------------------
  t(
    'process-need-approval',
    ['need approval', 'run it by', 'get sign off', 'get signoff', 'needs sign off'],
    'Approval needed',
    'Ask who signs and what they will need to see.',
    'process'
  ),
  t(
    'process-not-decision-maker',
    ['not my decision', 'not the decision maker', 'above my pay grade'],
    'Not the decider',
    'Ask to be introduced — and what matters to whoever decides.',
    'process'
  ),
  t(
    'process-committee',
    ['the committee', 'steering group', 'buying committee', 'procurement team'],
    'Committee',
    'Ask who else is in the room and what each of them cares about.',
    'process'
  ),
  t(
    'process-procurement',
    ['procurement', 'vendor onboarding', 'supplier review'],
    'Procurement',
    'Ask how long their process usually takes and what starts it.',
    'process'
  ),
  t(
    'process-legal-review',
    ['legal review', 'our legal team', 'legal has to look'],
    'Legal review',
    'Ask what usually holds legal up — start it in parallel.',
    'process'
  ),
  t(
    'process-security-review',
    ['security review', 'infosec', 'security questionnaire', 'soc two', 'soc 2'],
    'Security review',
    'Offer the documentation now rather than waiting to be asked.',
    'process'
  ),
  t(
    'process-pilot',
    ['a pilot', 'trial period', 'proof of concept', 'a poc'],
    'Pilot ask',
    'Agree what success looks like before agreeing to the pilot.',
    'process'
  ),

  // --- Competition ----------------------------------------------------------
  t(
    'comp-already-have',
    ['already have a', 'already using', 'we use something', 'we already work with'],
    'Incumbent',
    'Ask what it does well before saying anything about it.',
    'competitor'
  ),
  t(
    'comp-evaluating-others',
    ['looking at other', 'evaluating a few', 'talking to a couple', 'shortlist'],
    'In a bake-off',
    'Ask what their criteria are — then sell to those.',
    'competitor'
  ),
  t(
    'comp-switching-cost',
    ['cost of switching', 'painful to migrate', 'rip and replace', 'migration effort'],
    'Switching cost',
    'Name the migration path concretely; vagueness reads as risk.',
    'competitor'
  ),
  t(
    'comp-build-inhouse',
    ['build it ourselves', 'build in house', 'our own engineers could'],
    'Build vs buy',
    'Ask who maintains it in year two.',
    'competitor'
  ),
  t(
    'comp-happy-with-current',
    ['happy with what we have', 'works fine for us', 'no complaints'],
    'Happy already',
    'Ask what they would change if they could change one thing.',
    'competitor'
  ),

  // --- Risk and trust -------------------------------------------------------
  t(
    'risk-too-small',
    ['you are a startup', 'youre a startup', 'small company', 'how long have you been around'],
    'Vendor risk',
    'Answer plainly, then move to customers who took the same bet.',
    'objection'
  ),
  t(
    'risk-references',
    ['any references', 'customers like us', 'case study', 'who else uses'],
    'Reference ask',
    'Offer a customer in their shape, not your biggest logo.',
    'objection'
  ),
  t(
    'risk-data-privacy',
    ['where is the data', 'data residency', 'gdpr', 'data protection', 'is it private'],
    'Data concern',
    'Be specific about where data lives and who can see it.',
    'objection'
  ),
  t(
    'risk-integration',
    ['does it integrate', 'work with our', 'our current stack', 'api available'],
    'Integration',
    'Confirm the specific system before promising anything.',
    'objection'
  ),
  t(
    'risk-adoption',
    ['team will not use', 'team wont use', 'adoption', 'get people to use it'],
    'Adoption worry',
    'Ask what happened last time they rolled something out.',
    'objection'
  ),
  t(
    'risk-lock-in',
    ['locked in', 'lock in', 'contract length', 'multi year'],
    'Lock-in',
    'Lead with how they leave — it is what makes staying safe.',
    'objection'
  ),

  // --- Buying signals -------------------------------------------------------
  t(
    'signal-how-do-we-start',
    ['how do we get started', 'what happens next', 'next steps look like'],
    'Buying signal',
    'They are ready. Propose the specific next step now.',
    'process'
  ),
  t(
    'signal-pricing-detail',
    ['how does pricing work', 'per seat', 'per user', 'what would it cost us'],
    'Pricing question',
    'Answer directly, then ask what they are budgeting against.',
    'pricing'
  ),
  t(
    'signal-timeline',
    ['live by', 'up and running by', 'need it before', 'go live'],
    'Timeline signal',
    'Work backwards from their date, out loud, together.',
    'process'
  ),
  t(
    'signal-who-else',
    ['who else on my team', 'bring in my', 'introduce you to'],
    'Expanding the room',
    'Say yes, and ask what that person will want to know.',
    'process'
  )
]
