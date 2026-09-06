// M36 Stage 3 item 5, step 4 — the AS-OF notice: the CONTEXT section that
// tells the model a question was about a moment in the past, which moment
// the words resolved to, and — when nothing was valid then — the founder's
// refusal, verbatim in spirit: "I can't tell you what was true then — the
// earliest fact I have is from {valid_from}." It says what it doesn't know
// and why, and gives the boundary rather than a shrug.
//
// A pure leaf with no runtime imports, like unbound-client-notice.ts, so the
// turn test can assert the REAL text with everything heavy mocked.
import type { LookupSection } from './tools'
import type { AsOfQuestion } from '../memory/temporal-question'

const day = (iso: string): string => iso.slice(0, 10)

/**
 * @param question   what the parser read from the user's words
 * @param retrieved  how many memories were valid at that moment
 * @param earliest   the earliest valid_from across the scopes this turn
 *                   searched (ISO), or null when nothing is dated at all
 */
export function asOfQuestionNotice(question: AsOfQuestion, retrieved: number, earliest: string | null): LookupSection {
  const when = day(question.asOf)
  const read =
    question.precision === 'month' || question.precision === 'quarter' || question.precision === 'year'
      ? `"${question.phrase}", read as the end of that period (${when})`
      : `"${question.phrase}", read as ${when}`
  if (retrieved > 0) {
    return {
      title: 'AS-OF QUESTION — ANSWER FROM WHAT WAS TRUE THEN',
      lines: [
        {
          text:
            `The user asked about ${read}. The memories in this context are the ones that were valid at that ` +
            `moment; a fact that has since been superseded is included because it WAS true then. Answer from ` +
            `them, say which period the answer covers, and if the current fact differs, say so in one clause. ` +
            `A memory whose date is marked approximate may be dated by when it was learned rather than when it ` +
            `became true — say "around" rather than a precise date for those.`
        }
      ]
    }
  }
  return {
    title: 'AS-OF QUESTION — NOTHING KNOWN FOR THAT TIME',
    lines: [
      {
        text:
          `The user asked about ${read}, and no memory in the scopes searched for this question was valid at ` +
          `that moment. ` +
          (earliest
            ? `Say plainly: "I can't tell you what was true then — the earliest fact I have is from ${day(earliest)}." `
            : `Say plainly that you cannot tell what was true then because nothing dated that far back is known. `) +
          `Do NOT answer from current facts as if they applied at that time.`
      }
    ]
  }
}
