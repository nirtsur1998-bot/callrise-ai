import { AlertTriangle } from 'lucide-react'
import { Badge } from '@renderer/components/Badge'

/** "Needs follow-up" flag — shown on a deal card/row once its contact has
 *  gone quiet longer than Settings → CRM's threshold. Never just a color;
 *  always icon + text, so it isn't lost on hover states or for colorblind users. */
export function StaleBadge(): React.JSX.Element {
  return (
    <Badge
      tone="warning"
      icon={AlertTriangle}
      title="No calls with this contact in a while — may need a follow-up"
    >
      Follow up
    </Badge>
  )
}
