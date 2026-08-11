// alert-dispatcher — the cron-triggered heart of M19 Task 1.
//
// Deploy: `supabase functions deploy alert-dispatcher --no-verify-jwt`
// (--no-verify-jwt because pg_cron/pg_net calls it with a project-internal
// bearer token, never a user's Supabase auth JWT — see the header comment in
// supabase/alerts-schema.sql for the exact pg_cron job to create).
//
// Secrets this function needs (`supabase secrets set NAME=value`):
//   CRON_DISPATCH_KEY    - shared secret; must match the Vault secret the
//                          cron job sends as its Authorization bearer.
//   TELEGRAM_BOT_TOKEN   - same bot token used by telegram-webhook.
//   RESEND_API_KEY       - for email sends (https://resend.com).
//   RESEND_FROM_ADDRESS  - the "from" address, e.g. 'CallRise AI <alerts@yourdomain.com>'.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
// the Supabase edge runtime — do not set them yourself.
//
// What it does, every time pg_cron calls it (once a minute):
//   1. Derive: ask Postgres to compute what's newly due for each of the 4
//      trigger types (idempotent upserts — see alerts-schema.sql).
//   2. Claim: atomically grab up to BATCH_SIZE due rows (FOR UPDATE SKIP
//      LOCKED), for every channel type EXCEPT 'desktop' (that one is handled
//      by the running app's own Realtime subscription — see alerts.ts).
//   3. Quiet hours: meeting_starting/task_due are time-critical and always
//      bypass quiet hours (a held meeting reminder delivered after the
//      meeting is useless); deal_cold/no_next_step respect them.
//   4. Send via the matching channel, record the result, and let
//      mark_delivery_result() update the channel's health counters.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { json, text } from '../_shared/cors.ts'

const BATCH_SIZE = 100

interface ClaimedDelivery {
  delivery_id: string
  rule_id: string
  user_id: string
  trigger_type: 'meeting_starting' | 'task_due' | 'deal_cold' | 'no_next_step'
  params: Record<string, unknown>
  channel_id: string
  channel_type: 'telegram' | 'email' | 'whatsapp'
  channel_address: string | null
  subject_type: 'event' | 'task' | 'deal'
  subject_id: string
  scheduled_fire_at: string
}

const TIME_CRITICAL: Record<string, boolean> = {
  meeting_starting: true,
  task_due: true,
  deal_cold: false,
  no_next_step: false
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`)
}

function messageFor(d: ClaimedDelivery): { title: string; body: string } {
  switch (d.trigger_type) {
    case 'meeting_starting':
      return { title: 'Meeting starting soon', body: 'A synced calendar event is about to begin.' }
    case 'task_due':
      return { title: 'Task due', body: 'One of your tasks has reached its due time.' }
    case 'deal_cold':
      return { title: 'Deal gone cold', body: "You haven't touched this deal in a while — worth a check-in?" }
    case 'no_next_step':
      return { title: 'No next step booked', body: 'A recent call ended without a follow-up scheduled.' }
  }
}

async function isQuietHours(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<'none' | 'hold' | 'drop'> {
  const { data: settings } = await supabase
    .from('user_alert_settings')
    .select('timezone, quiet_hours_start, quiet_hours_end, quiet_hours_behavior')
    .eq('user_id', userId)
    .maybeSingle()
  if (!settings?.quiet_hours_start || !settings?.quiet_hours_end) return 'none'

  const tz = settings.timezone || 'UTC'
  const now = new Date()
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(now)
  const [h, m] = local.split(':').map(Number)
  const nowMin = h * 60 + m
  const [sh, sm] = settings.quiet_hours_start.split(':').map(Number)
  const [eh, em] = settings.quiet_hours_end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em

  const inWindow =
    startMin <= endMin ? nowMin >= startMin && nowMin < endMin : nowMin >= startMin || nowMin < endMin
  if (!inWindow) return 'none'
  return settings.quiet_hours_behavior === 'drop' ? 'drop' : 'hold'
}

async function sendTelegram(
  chatId: string,
  title: string,
  body: string
): Promise<{ ok: boolean; message?: string }> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  if (!token) return { ok: false, message: 'TELEGRAM_BOT_TOKEN not set' }
  const raw = `*${title}*\n${body}`
  const escaped = escapeMarkdownV2(raw).replace(/\\\*/g, '*') // keep the bold markers we intentionally added
  const send = async (text: string, parseMode?: string): Promise<{ ok: boolean; description?: string }> => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true })
    })
    return await res.json()
  }
  const first = await send(escaped, 'MarkdownV2')
  if (first.ok) return { ok: true }
  // Any parse_mode failure — fall back to plain text rather than dropping the alert.
  const retry = await send(`${title}\n${body}`)
  if (retry.ok) return { ok: true }
  return { ok: false, message: retry.description ?? first.description }
}

async function sendEmail(to: string, title: string, body: string): Promise<{ ok: boolean; message?: string }> {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  const from = Deno.env.get('RESEND_FROM_ADDRESS')
  if (!apiKey || !from) return { ok: false, message: 'RESEND_API_KEY/RESEND_FROM_ADDRESS not set' }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: `CallRise AI — ${title}`,
      html: `<p><strong>${title}</strong></p><p>${body}</p>`,
      text: `${title}\n\n${body}`
    })
  })
  if (res.ok) return { ok: true }
  const msg = await res.text().catch(() => '')
  return { ok: false, message: msg.slice(0, 300) }
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('CRON_DISPATCH_KEY')
  const auth = req.headers.get('Authorization')
  if (!expected || auth !== `Bearer ${expected}`) {
    return text('unauthorized', 401)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // 1. Derive newly-due deliveries for each trigger type. Each is its own
  // idempotent upsert (ON CONFLICT DO NOTHING) — safe to run every tick.
  await Promise.all([
    supabase.rpc('derive_meeting_alerts'),
    supabase.rpc('derive_task_alerts'),
    supabase.rpc('derive_deal_cold_alerts'),
    supabase.rpc('derive_no_next_step_alerts')
  ])

  // Desktop-channel rows that never got picked up while the app was closed.
  await supabase.rpc('expire_stale_desktop_deliveries')

  // 2. Claim a batch (excludes 'desktop' channels — see header comment).
  const { data: claimed, error: claimError } = await supabase.rpc('claim_due_deliveries', {
    batch_size: BATCH_SIZE
  })
  if (claimError) {
    return json({ ok: false, error: claimError.message }, 500)
  }

  const rows = (claimed ?? []) as ClaimedDelivery[]
  let sent = 0
  let failed = 0
  let held = 0

  for (const row of rows) {
    if (!TIME_CRITICAL[row.trigger_type]) {
      const quiet = await isQuietHours(supabase, row.user_id)
      if (quiet === 'drop') {
        await supabase.rpc('mark_delivery_result', { p_delivery_id: row.delivery_id, p_status: 'skipped_app_closed' })
        continue
      }
      if (quiet === 'hold') {
        await supabase.rpc('mark_delivery_result', { p_delivery_id: row.delivery_id, p_status: 'held' })
        held++
        continue
      }
    }

    const { title, body } = messageFor(row)
    let result: { ok: boolean; message?: string }
    if (row.channel_type === 'telegram' && row.channel_address) {
      result = await sendTelegram(row.channel_address, title, body)
    } else if (row.channel_type === 'email' && row.channel_address) {
      result = await sendEmail(row.channel_address, title, body)
    } else {
      result = { ok: false, message: 'channel not configured or missing address' }
    }

    if (result.ok) {
      sent++
      await supabase.rpc('mark_delivery_result', { p_delivery_id: row.delivery_id, p_status: 'sent' })
    } else {
      failed++
      await supabase.rpc('mark_delivery_result', {
        p_delivery_id: row.delivery_id,
        p_status: 'failed',
        p_error: result.message ?? 'unknown error'
      })
    }
  }

  return json({ ok: true, claimed: rows.length, sent, failed, held })
})
