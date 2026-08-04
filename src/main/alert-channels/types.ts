// Shared types for the alert channel abstraction (M19 Task 1). Adding a new
// channel (Slack, SMS, …) means writing one adapter against this interface
// and changing nothing else — the dispatcher and rules UI are channel-agnostic.

export type ChannelType = 'telegram' | 'email' | 'whatsapp'

export interface AlertMessage {
  /** Short, human title — e.g. "Meeting starting in 10 minutes". */
  title: string
  /** One or two sentence body. */
  body: string
  /** Optional deep link (callrise://...) the recipient can act on. */
  actionUrl?: string
  actionLabel?: string
}

export type ChannelPayload =
  | { kind: 'telegram'; text: string; parseMode: 'MarkdownV2' | 'None' }
  | { kind: 'email'; subject: string; html: string; text: string }
  | {
      kind: 'whatsapp'
      template: { name: string; language: string; components: unknown[] }
    }

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: 'not-configured' | 'send-failed' | 'unhealthy' | 'revoked'; message?: string }

/**
 * A handle describing how to complete verification for a channel that has no
 * up-front address (Telegram: the address only exists once the bot's webhook
 * receives /start and binds a chat_id). Channels that DO have an address up
 * front (email) instead return a 'pending-code' handle after the address is
 * submitted and a verification code/link is sent to it.
 */
export type VerificationHandle =
  | { kind: 'deep-link'; url: string; qrData: string; expiresAt: string }
  | { kind: 'pending-code'; expiresAt: string }
  | { kind: 'not-applicable' } // whatsapp: verification happens outside the app (Meta Business)

export interface NotificationChannelRow {
  id: string
  user_id: string
  type: ChannelType
  address: string | null
  label: string | null
  verified_at: string | null
  verification_token: string | null
  verification_expires_at: string | null
  consecutive_failures: number
  unhealthy_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export interface ChannelAdapter {
  type: ChannelType
  /** Begin verification. `input` is the user-submitted address for channels
   *  that need one up front (email); omitted for Telegram (deep-link only). */
  verify(channelId: string, input?: string): Promise<VerificationHandle>
  send(channel: NotificationChannelRow, payload: ChannelPayload): Promise<DeliveryResult>
  format(msg: AlertMessage): ChannelPayload
}
