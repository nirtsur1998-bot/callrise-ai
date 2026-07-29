// Scheduled alerts — main-process IPC layer (M19 Task 1).
//
// Unlike contacts/tasks/deals, alert rules/channels/deliveries live ENTIRELY
// in Supabase, not as local JSON files with an optional cloud mirror. The
// whole point of this feature is firing while the laptop is closed, so the
// desktop app can only ever be a thin CRUD client over the same tables the
// (server-side) dispatcher reads — there is no local copy to be the "source
// of truth" the way calls/tasks are.

import { ipcMain, Notification, BrowserWindow } from 'electron'
import { getSupabaseClient, getSignedInUserId } from './auth'
import {
  generateNonce,
  telegramDeepLink,
  sendTelegramMessage,
  escapeMarkdownV2,
  NONCE_TTL_MS,
  MAX_FAILURES_BEFORE_UNHEALTHY
} from './alert-channels/telegram'
import { generateVerificationCode, isValidEmail, EMAIL_CODE_TTL_MS } from './alert-channels/email'
import { whatsAppStatus } from './alert-channels/whatsapp'
import type { ChannelType } from './alert-channels/types'

const TRIGGER_LABELS: Record<TriggerType, string> = {
  meeting_starting: 'Meeting starting',
  task_due: 'Task due',
  deal_cold: 'Deal gone cold',
  no_next_step: 'No next step booked'
}

/** Creates this device's 'desktop' channel row once per account, so alert
 *  rules have something to attach a "notify while running" delivery to. No
 *  verification needed — it's a statement about this signed-in account, not
 *  an external address. Idempotent: safe to call on every app start. */
async function ensureDesktopChannel(): Promise<void> {
  const client = getSupabaseClient()
  const userId = await getSignedInUserId()
  if (!client || !userId) return
  const { data: existing } = await client
    .from('notification_channels')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'desktop')
    .is('revoked_at', null)
    .maybeSingle()
  if (existing) return
  await client.from('notification_channels').insert({
    user_id: userId,
    type: 'desktop' as ChannelType,
    label: 'This device (while running)',
    verified_at: new Date().toISOString()
  })
}

/** Subscribes to new alert_deliveries rows for THIS account's desktop
 *  channel(s) while the app is running, raises the native OS notification,
 *  and immediately acks the row via the narrow ack_desktop_delivery RPC — the
 *  one delivery-status write a signed-in (non-service-role) client is allowed
 *  to make. If the app isn't running, the row is simply never acked, and
 *  expire_stale_desktop_deliveries() (run by the dispatcher) marks it
 *  'skipped_app_closed' instead of replaying it later. */
let desktopSubscribed = false

function subscribeDesktopDeliveries(): void {
  if (desktopSubscribed) return
  const client = getSupabaseClient()
  if (!client) return
  desktopSubscribed = true
  client
    .channel('alert-deliveries-desktop')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'alert_deliveries' },
      (payload) => {
        const row = payload.new as {
          id: string
          status: string
          rule_id: string
        }
        if (row.status !== 'pending') return
        void handleDesktopDelivery(row.id, row.rule_id)
      }
    )
    .subscribe()
}

async function handleDesktopDelivery(deliveryId: string, ruleId: string): Promise<void> {
  const client = getSupabaseClient()
  if (!client) return
  // Confirm this delivery is actually routed to a desktop channel of ours —
  // the subscription above sees every INSERT (RLS narrows SELECT visibility,
  // not the realtime payload shape), so this is the real gate.
  const { data: rule } = await client.from('alert_rules').select('trigger_type').eq('id', ruleId).maybeSingle()
  if (!rule) return
  const { error } = await client.rpc('ack_desktop_delivery', { p_delivery_id: deliveryId })
  if (error) return // row wasn't ours, already handled, or not a desktop channel — nothing to show
  const title = TRIGGER_LABELS[rule.trigger_type as TriggerType] ?? 'CallRise AI'
  const win = BrowserWindow.getAllWindows()[0]
  const notification = new Notification({
    title,
    body: 'Open CallRise AI for details.'
  })
  if (win) {
    notification.on('click', () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
  }
  notification.show()
}

export type TriggerType = 'meeting_starting' | 'task_due' | 'deal_cold' | 'no_next_step'

export interface AlertRuleInput {
  triggerType?: unknown
  leadTimeMinutes?: unknown
  enabled?: unknown
  params?: unknown
  channelIds?: unknown // array of notification_channels.id, replaces the join rows wholesale
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function sanitizeTriggerType(value: unknown): TriggerType | null {
  return value === 'meeting_starting' || value === 'task_due' || value === 'deal_cold' || value === 'no_next_step'
    ? value
    : null
}

// 1/5/10/15/30/60 are the fixed dropdown values; "custom" is any positive
// integer the renderer already validated — we just bound it to something sane.
function sanitizeLeadTimeMinutes(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 10_080) return null // cap at 1 week
  return Math.round(n)
}

let registered = false

export function registerAlerts(): void {
  if (registered) return
  registered = true

  void ensureDesktopChannel()
  subscribeDesktopDeliveries()
  // A fresh sign-in has no desktop channel yet at registerAlerts() time (auth
  // hasn't resolved), and a sign-out/sign-in swap needs a fresh subscription
  // scoped to the new account — getClient() itself is a singleton, but the
  // realtime channel subscribed above was created before any user existed.
  getSupabaseClient()?.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') {
      void ensureDesktopChannel()
      subscribeDesktopDeliveries()
    }
  })

  // --- Channels --------------------------------------------------------------

  ipcMain.handle('alerts:channels:list', async () => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return []
    const { data, error } = await client
      .from('notification_channels')
      .select('*')
      .is('revoked_at', null)
      .order('created_at', { ascending: true })
    if (error) return []
    return data ?? []
  })

  // Telegram: create a channel row with a fresh single-use nonce and return
  // the deep link + QR payload. The renderer polls `alerts.channels.list`
  // (or a Realtime subscription) to notice when verified_at gets set by the
  // webhook.
  ipcMain.handle('alerts:channels:startTelegramVerify', async (_event, label?: string) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return { ok: false, error: 'not-signed-in' as const }
    const link = telegramDeepLink('placeholder')
    if (!link) return { ok: false, error: 'not-configured' as const }

    const nonce = generateNonce()
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString()
    const { data, error } = await client
      .from('notification_channels')
      .insert({
        user_id: userId,
        type: 'telegram' as ChannelType,
        label: typeof label === 'string' ? label.slice(0, 100) : 'Telegram',
        verification_token: nonce,
        verification_expires_at: expiresAt
      })
      .select('id')
      .single()
    if (error || !data) return { ok: false, error: 'create-failed' as const }

    return {
      ok: true as const,
      channelId: data.id as string,
      deepLink: telegramDeepLink(nonce),
      qrData: telegramDeepLink(nonce),
      expiresAt
    }
  })

  // Email: create a channel row (unverified) + a 6-digit code, then invoke
  // the edge function that actually sends it (Resend, not Supabase's
  // GoTrue-only SMTP setting).
  ipcMain.handle('alerts:channels:startEmailVerify', async (_event, address: unknown) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return { ok: false, error: 'not-signed-in' as const }
    if (typeof address !== 'string' || !isValidEmail(address)) {
      return { ok: false, error: 'invalid-email' as const }
    }
    const email = address.trim().toLowerCase()
    const code = generateVerificationCode()
    const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString()

    const { data, error } = await client
      .from('notification_channels')
      .insert({
        user_id: userId,
        type: 'email' as ChannelType,
        address: email,
        label: email,
        verification_token: code,
        verification_expires_at: expiresAt
      })
      .select('id')
      .single()
    if (error || !data) return { ok: false, error: 'create-failed' as const }

    const { error: fnError } = await client.functions.invoke('send-verification-email', {
      body: { email, code }
    })
    if (fnError) {
      // Row stays around unverified; the user can retry from the same card.
      return { ok: false, error: 'send-failed' as const, channelId: data.id as string }
    }
    return { ok: true as const, channelId: data.id as string, expiresAt }
  })

  ipcMain.handle('alerts:channels:confirmEmailCode', async (_event, channelId: unknown, code: unknown) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId || !isSafeId(channelId) || typeof code !== 'string') {
      return { ok: false, error: 'invalid-input' as const }
    }
    const { data, error } = await client
      .from('notification_channels')
      .select('verification_token, verification_expires_at')
      .eq('id', channelId)
      .eq('user_id', userId)
      .single()
    if (error || !data) return { ok: false, error: 'not-found' as const }
    if (!data.verification_expires_at || new Date(data.verification_expires_at).getTime() < Date.now()) {
      return { ok: false, error: 'expired' as const }
    }
    if (data.verification_token !== code.trim()) {
      return { ok: false, error: 'wrong-code' as const }
    }
    const { error: updateError } = await client
      .from('notification_channels')
      .update({ verified_at: new Date().toISOString(), verification_token: null })
      .eq('id', channelId)
    if (updateError) return { ok: false, error: 'update-failed' as const }
    return { ok: true as const }
  })

  ipcMain.handle('alerts:channels:delete', async (_event, channelId: unknown) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId || !isSafeId(channelId)) return { ok: false }
    // Revoke rather than hard-delete: alert_rule_channels and alert_deliveries
    // reference this row, and a hard delete would cascade-wipe delivery
    // history that's still useful for "why did this stop notifying me".
    const { error } = await client
      .from('notification_channels')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', channelId)
      .eq('user_id', userId)
    return { ok: !error }
  })

  ipcMain.handle('alerts:channels:whatsappStatus', () => whatsAppStatus())

  // "Send test alert" — the one place the desktop app sends directly rather
  // than going through the dispatcher, since the whole point of a test is
  // confirming delivery works RIGHT NOW while the user is watching.
  ipcMain.handle('alerts:channels:testSend', async (_event, channelId: unknown) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId || !isSafeId(channelId)) return { ok: false, error: 'invalid-input' as const }
    const { data: channel, error } = await client
      .from('notification_channels')
      .select('*')
      .eq('id', channelId)
      .eq('user_id', userId)
      .single()
    if (error || !channel) return { ok: false, error: 'not-found' as const }
    if (!channel.verified_at) return { ok: false, error: 'unverified' as const }

    if (channel.type === 'telegram') {
      const text = escapeMarkdownV2(
        'CallRise AI: this is a test alert. If you can read this, Telegram delivery is working.'
      )
      const result = await sendTelegramMessage(channel.address, text, 'MarkdownV2')
      return result.ok ? { ok: true as const } : { ok: false as const, error: 'send-failed' as const, message: result.message }
    }
    if (channel.type === 'email') {
      const { error: fnError } = await client.functions.invoke('send-test-alert-email', {
        body: { email: channel.address }
      })
      return fnError ? { ok: false as const, error: 'send-failed' as const } : { ok: true as const }
    }
    return { ok: false as const, error: 'not-configured' as const }
  })

  // --- Rules -------------------------------------------------------------------

  ipcMain.handle('alerts:rules:list', async () => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return []
    const { data: rules, error } = await client
      .from('alert_rules')
      .select('*, alert_rule_channels(channel_id)')
      .order('created_at', { ascending: true })
    if (error) return []
    return rules ?? []
  })

  ipcMain.handle('alerts:rules:create', async (_event, input: AlertRuleInput) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return null
    const triggerType = sanitizeTriggerType(input?.triggerType)
    if (!triggerType) return null

    const needsLeadTime = triggerType === 'meeting_starting' || triggerType === 'task_due'
    const leadTimeMinutes = needsLeadTime ? sanitizeLeadTimeMinutes(input?.leadTimeMinutes) : null
    if (needsLeadTime && leadTimeMinutes === null) return null

    const { data: rule, error } = await client
      .from('alert_rules')
      .insert({
        user_id: userId,
        trigger_type: triggerType,
        lead_time_minutes: leadTimeMinutes,
        enabled: input?.enabled !== false,
        params: input?.params && typeof input.params === 'object' ? input.params : {}
      })
      .select('*')
      .single()
    if (error || !rule) return null

    const channelIds = Array.isArray(input?.channelIds) ? input.channelIds.filter(isSafeId) : []
    if (channelIds.length > 0) {
      await client
        .from('alert_rule_channels')
        .insert(channelIds.map((channelId) => ({ rule_id: rule.id, channel_id: channelId })))
    }
    return rule
  })

  ipcMain.handle('alerts:rules:update', async (_event, ruleId: unknown, patch: AlertRuleInput) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId || !isSafeId(ruleId)) return null

    const update: Record<string, unknown> = {}
    if (patch?.enabled !== undefined) update.enabled = patch.enabled === true
    if (patch?.leadTimeMinutes !== undefined) {
      const n = sanitizeLeadTimeMinutes(patch.leadTimeMinutes)
      if (n !== null) update.lead_time_minutes = n
    }
    if (patch?.params && typeof patch.params === 'object') update.params = patch.params

    if (Object.keys(update).length > 0) {
      const { error } = await client.from('alert_rules').update(update).eq('id', ruleId).eq('user_id', userId)
      if (error) return null
    }

    if (Array.isArray(patch?.channelIds)) {
      const channelIds = patch.channelIds.filter(isSafeId)
      // Replace wholesale — simpler and safer than diffing, and rule-channel
      // membership changes are rare/small (a handful of channels per rule).
      await client.from('alert_rule_channels').delete().eq('rule_id', ruleId)
      if (channelIds.length > 0) {
        await client
          .from('alert_rule_channels')
          .insert(channelIds.map((channelId) => ({ rule_id: ruleId, channel_id: channelId })))
      }
    }

    const { data } = await client.from('alert_rules').select('*, alert_rule_channels(channel_id)').eq('id', ruleId).single()
    return data ?? null
  })

  ipcMain.handle('alerts:rules:delete', async (_event, ruleId: unknown) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId || !isSafeId(ruleId)) return { ok: false }
    const { error } = await client.from('alert_rules').delete().eq('id', ruleId).eq('user_id', userId)
    return { ok: !error }
  })

  // --- Settings ------------------------------------------------------------------

  ipcMain.handle('alerts:settings:get', async () => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return null
    const { data } = await client.from('user_alert_settings').select('*').eq('user_id', userId).maybeSingle()
    return data
  })

  ipcMain.handle('alerts:settings:update', async (_event, patch: Record<string, unknown>) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return null
    const { data, error } = await client
      .from('user_alert_settings')
      .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
      .select('*')
      .single()
    if (error) return null
    return data
  })

  // --- Delivery history (read-only; useful for "why isn't this notifying me") ---

  ipcMain.handle('alerts:deliveries:recent', async (_event, limit?: unknown) => {
    const client = getSupabaseClient()
    const userId = await getSignedInUserId()
    if (!client || !userId) return []
    const cap = typeof limit === 'number' && limit > 0 && limit <= 200 ? limit : 50
    const { data } = await client
      .from('alert_deliveries')
      .select('*, alert_rules!inner(user_id)')
      .eq('alert_rules.user_id', userId)
      .order('scheduled_fire_at', { ascending: false })
      .limit(cap)
    return data ?? []
  })
}

export { MAX_FAILURES_BEFORE_UNHEALTHY }
