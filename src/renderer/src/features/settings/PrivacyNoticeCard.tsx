import { Card } from '@renderer/components/Card'

/** A short, honest recap above the backup details: what stays local, and the
 *  same consent-laws-vary reminder used in Recording & consent. */
export function PrivacyNoticeCard(): React.JSX.Element {
  return (
    <Card className="mb-5">
      <p className="text-[13px] text-muted">
        Your call recordings, transcripts, knowledge base, and app settings live only on this
        device. The summary below shows what does back up to your account.
      </p>
      <p className="mt-3 border-t border-line-soft pt-3 text-[12px] text-faint">
        Consent laws for recording calls vary by location — you&rsquo;re responsible for checking
        what applies where you and the other party are.
      </p>
    </Card>
  )
}
