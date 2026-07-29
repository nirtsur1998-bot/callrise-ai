import { useEffect, useState } from 'react'
import { Send, Mail, MessageCircle, Trash2, CheckCircle2, AlertTriangle, Copy } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { Badge } from '@renderer/components/Badge'
import { fieldClass } from '@renderer/components/field'
import type { NotificationChannel } from './useAlerts'

interface ChannelsCardProps {
  channels: NotificationChannel[]
  onDelete: (channelId: string) => Promise<void>
  onReload: () => Promise<void>
}

type PendingTelegram = { channelId: string; deepLink: string | null; expiresAt: string } | null
type PendingEmail = { channelId: string; address: string } | null

/** Channel setup + list: Telegram (deep-link + single-use nonce), email
 *  (double opt-in code), WhatsApp (greyed out, "Coming soon"). */
export function ChannelsCard({ channels, onDelete, onReload }: ChannelsCardProps): React.JSX.Element {
  const [pendingTelegram, setPendingTelegram] = useState<PendingTelegram>(null)
  const [pendingEmail, setPendingEmail] = useState<PendingEmail>(null)
  const [emailInput, setEmailInput] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [whatsappConfigured, setWhatsappConfigured] = useState(false)

  useEffect(() => {
    void window.api.alerts.channels.whatsappStatus().then((s) => setWhatsappConfigured(s.configured))
  }, [])

  // While a Telegram deep link is pending, poll for the webhook having bound
  // a chat_id — the whole point of the deep-link flow is that the user acts
  // on their PHONE, so nothing in this window tells us it happened otherwise.
  useEffect(() => {
    if (!pendingTelegram) return
    const interval = window.setInterval(() => {
      void window.api.alerts.channels.list().then((fresh) => {
        const match = fresh.find((c) => c.id === pendingTelegram.channelId)
        if (match?.verified_at) {
          setPendingTelegram(null)
          void onReload()
        } else if (new Date(pendingTelegram.expiresAt).getTime() < Date.now()) {
          setPendingTelegram(null)
          setError('That link expired before it was used — generate a new one.')
        }
      })
    }, 3000)
    return () => window.clearInterval(interval)
  }, [pendingTelegram, onReload])

  const startTelegram = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const res = await window.api.alerts.channels.startTelegramVerify()
      if (res.ok) {
        setPendingTelegram({ channelId: res.channelId, deepLink: res.deepLink, expiresAt: res.expiresAt })
      } else {
        setError(
          res.error === 'not-configured'
            ? 'Telegram isn’t configured for this app yet (missing bot credentials).'
            : 'Could not start Telegram setup — try again.'
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const startEmail = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const res = await window.api.alerts.channels.startEmailVerify(emailInput)
      if (res.ok) {
        setPendingEmail({ channelId: res.channelId, address: emailInput })
        setEmailInput('')
      } else {
        setError(res.error === 'invalid-email' ? 'Enter a valid email address.' : 'Could not send the verification code — try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const confirmEmail = async (): Promise<void> => {
    if (!pendingEmail) return
    setError(null)
    setBusy(true)
    try {
      const res = await window.api.alerts.channels.confirmEmailCode(pendingEmail.channelId, codeInput)
      if (res.ok) {
        setPendingEmail(null)
        setCodeInput('')
        await onReload()
      } else {
        setError(res.error === 'wrong-code' ? 'That code doesn’t match.' : res.error === 'expired' ? 'That code has expired — start again.' : 'Could not confirm the code.')
      }
    } finally {
      setBusy(false)
    }
  }

  const runTest = async (channelId: string): Promise<void> => {
    setTestResult((prev) => ({ ...prev, [channelId]: 'sending' }))
    const res = await window.api.alerts.channels.testSend(channelId)
    setTestResult((prev) => ({ ...prev, [channelId]: res.ok ? 'sent' : 'failed' }))
  }

  const iconFor = (type: string): React.JSX.Element => {
    if (type === 'telegram') return <Send className="h-4 w-4" />
    if (type === 'email') return <Mail className="h-4 w-4" />
    return <MessageCircle className="h-4 w-4" />
  }

  const nonDesktop = channels.filter((c) => c.type !== 'desktop')

  return (
    <Card className="mb-5">
      <p className="text-sm font-medium">Delivery channels</p>
      <p className="mt-1 mb-4 text-[12px] text-muted">
        Where alerts go when your laptop is closed. A desktop notification (while the app is
        running) is always available and needs no setup.
      </p>

      {error && (
        <p className="mb-3 flex items-center gap-1.5 text-[12px] text-danger">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}

      <div className="space-y-2">
        {nonDesktop.map((channel) => (
          <div
            key={channel.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-line-soft px-3 py-2"
          >
            <div className="flex items-center gap-2 text-[13px]">
              {iconFor(channel.type)}
              <span>{channel.label || channel.address || channel.type}</span>
              {channel.verified_at ? (
                <Badge tone="positive" icon={CheckCircle2}>
                  Verified
                </Badge>
              ) : (
                <Badge tone="warning">Pending</Badge>
              )}
              {channel.unhealthy_at && (
                <Badge tone="danger" icon={AlertTriangle} title="3+ consecutive delivery failures">
                  Unhealthy
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {channel.verified_at && (
                <Button size="sm" variant="secondary" onClick={() => void runTest(channel.id)}>
                  {testResult[channel.id] === 'sending'
                    ? 'Sending…'
                    : testResult[channel.id] === 'sent'
                      ? 'Sent ✅'
                      : testResult[channel.id] === 'failed'
                        ? 'Failed'
                        : 'Send test alert'}
                </Button>
              )}
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => void onDelete(channel.id)}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        {nonDesktop.length === 0 && <p className="text-[12px] text-faint">No channels connected yet.</p>}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 border-t border-line-soft pt-4 sm:grid-cols-3">
        <div className="rounded-lg border border-line-soft p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
            <Send className="h-4 w-4" /> Telegram
          </p>
          {pendingTelegram ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted">
                Open this link on the device with Telegram, then tap Start:
              </p>
              {pendingTelegram.deepLink ? (
                <div className="flex items-center gap-1.5">
                  <a
                    href={pendingTelegram.deepLink}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-[11px] text-accent underline"
                  >
                    {pendingTelegram.deepLink}
                  </a>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(pendingTelegram.deepLink ?? '')}
                    className="text-faint hover:text-ink"
                    title="Copy link"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-danger">Bot not configured.</p>
              )}
              <p className="text-[11px] text-faint">
                Link expires {new Date(pendingTelegram.expiresAt).toLocaleTimeString()}. This screen
                updates automatically once connected.
              </p>
              <Button size="sm" variant="secondary" onClick={() => setPendingTelegram(null)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" fullWidth disabled={busy} onClick={() => void startTelegram()}>
              Connect Telegram
            </Button>
          )}
        </div>

        <div className="rounded-lg border border-line-soft p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
            <Mail className="h-4 w-4" /> Email
          </p>
          {pendingEmail ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted">Enter the code sent to {pendingEmail.address}:</p>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="123456"
                className={fieldClass}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void confirmEmail()}>
                  Confirm
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPendingEmail(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="you@example.com"
                className={fieldClass}
              />
              <Button size="sm" variant="secondary" fullWidth disabled={busy || !emailInput} onClick={() => void startEmail()}>
                Send code
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-line-soft p-3 opacity-60">
          <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
            <MessageCircle className="h-4 w-4" /> WhatsApp
          </p>
          <Badge tone="neutral">Coming soon</Badge>
          <p className="mt-2 text-[11px] text-faint">
            {whatsappConfigured
              ? 'Configured, but not yet exposed in this screen.'
              : 'Needs Meta Business verification and template approval — see docs/whatsapp-setup.md.'}
          </p>
        </div>
      </div>
    </Card>
  )
}
