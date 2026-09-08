import { Card } from '@renderer/components/Card'

/** The opening card on Privacy & data — the three places call data goes.
 *
 *  ROUND FIVE, 2026-09-08, founder-approved word by word. This card used to
 *  say "Your call recordings, transcripts, knowledge base, and app settings
 *  live only on this device", which was false for transcripts, the knowledge
 *  base and app settings, and named a category ("recordings") that does not
 *  exist anywhere in the product.
 *
 *  WHY THE SHAPE CHANGED, and it is the finding of the milestone rather than a
 *  wording preference: every round of privacy copy before this one sorted user
 *  data into TWO boxes — this device, and your backup. There are three. The
 *  raw microphone audio of every call streams live to Deepgram
 *  (transcription.ts:487) with no toggle at all, and nothing in the product
 *  had ever named it. Nothing was mis-sorted; the category set was incomplete,
 *  which produces confident wrong answers with no error anywhere in the chain
 *  (taxonomy species 91). Four rounds of copy died to that.
 *
 *  Each paragraph is one destination, and each names what a user can do about
 *  it. Keep that structure if this is ever rewritten — the two-box version is
 *  what made every earlier draft false. */
export function PrivacyNoticeCard(): React.JSX.Element {
  return (
    <Card className="mb-5">
      <p className="text-[13px] font-medium text-ink">Where your call data goes.</p>
      <p className="mt-2 text-[13px] text-muted">
        <span className="font-medium text-ink">Deepgram</span> receives the audio of every call,
        live, as it happens — that&rsquo;s the transcription service your key connects to, and
        it&rsquo;s how your words become text at all.
      </p>
      <p className="mt-2 text-[13px] text-muted">
        <span className="font-medium text-ink">Your AI provider</span> receives the transcript
        whenever a feature reads a call: summaries, coaching, task extraction, live cues and Sales
        Brain. Turning a feature off is what stops it.
      </p>
      <p className="mt-2 text-[13px] text-muted">
        <span className="font-medium text-ink">Your CallRise backup</span> receives your tasks,
        calendar events, and each call&rsquo;s title, summary and coaching scores while you&rsquo;re
        signed in — plus whatever you switch on below.
      </p>
      <p className="mt-2 text-[13px] text-muted">All of it is also kept on this device.</p>
      <p className="mt-3 border-t border-line-soft pt-3 text-[12px] text-faint">
        Consent laws for recording calls vary by location — you&rsquo;re responsible for checking
        what applies where you and the other party are.
      </p>
    </Card>
  )
}
