import { AlertTriangle } from 'lucide-react'

/** "Needs follow-up" flag — shown on a deal card/row once its contact has
 *  gone quiet longer than Settings → CRM's threshold. Never just a color;
 *  always icon + text, so it isn't lost on hover states or for colorblind users. */
export function StaleBadge(): React.JSX.Element {
  return (
    <span
      title="No calls with this contact in a while — may need a follow-up"
      className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
    >
      <AlertTriangle className="h-3 w-3" /> Follow up
    </span>
  )
}
