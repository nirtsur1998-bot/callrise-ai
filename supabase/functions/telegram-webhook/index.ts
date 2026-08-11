// telegram-webhook — binds a Telegram chat_id to a pending channel row when
// the user taps the deep link and sends /start <nonce> (M19 Task 1).
//
// Deploy: `supabase functions deploy telegram-webhook --no-verify-jwt`
// (--no-verify-jwt because Telegram sends no Supabase auth header at all —
// this is authenticated instead by Telegram's OWN secret-token header, set
// below via setWebhook).
//
// One-time setup (after deploying):
//   1. Register the webhook with Telegram, including a secret token this
//      function verifies on every call:
//        curl -X POST https://api.telegram.org/bot<TOKEN>/setWebhook \
//          -d url=https://<project-ref>.supabase.co/functions/v1/telegram-webhook \
//          -d secret_token=<a random string you generate once>
//   2. `supabase secrets set TELEGRAM_WEBHOOK_SECRET=<that same random string>`
//   3. `supabase secrets set TELEGRAM_BOT_TOKEN=<the bot token>`
//
// Security: Telegram's `X-Telegram-Bot-Api-Secret-Token` header is the ONLY
// thing standing between this endpoint and the public internet — anyone who
// discovers the URL without it could otherwise bind arbitrary chat_ids to
// arbitrary nonces. Reject anything that doesn't match immediately.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { json, text } from '../_shared/cors.ts'

interface TelegramUpdate {
  message?: {
    chat: { id: number }
    text?: string
  }
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')
  const incoming = req.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (!secret || incoming !== secret) {
    return text('forbidden', 403)
  }

  let update: TelegramUpdate
  try {
    update = (await req.json()) as TelegramUpdate
  } catch {
    return text('bad request', 400)
  }

  const chatId = update.message?.chat?.id
  const messageText = update.message?.text?.trim() ?? ''
  const match = messageText.match(/^\/start\s+([A-Za-z0-9_-]{1,64})$/)
  if (!chatId || !match) {
    // Not a /start with a nonce — nothing to do, but still 200 so Telegram
    // doesn't retry-storm us.
    return json({ ok: true })
  }
  const nonce = match[1]

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Single-use + TTL: a leaked deep link must not be able to bind an
  // attacker's chat_id after the real recipient has already connected, or
  // ever, once it expires.
  const { data: channel, error } = await supabase
    .from('notification_channels')
    .select('id, verification_expires_at, verified_at')
    .eq('verification_token', nonce)
    .eq('type', 'telegram')
    .maybeSingle()

  if (error || !channel) {
    await sendPlain(chatId, 'This link is invalid or has already been used.')
    return json({ ok: true })
  }
  if (channel.verified_at) {
    await sendPlain(chatId, 'This channel is already connected.')
    return json({ ok: true })
  }
  if (!channel.verification_expires_at || new Date(channel.verification_expires_at).getTime() < Date.now()) {
    await sendPlain(chatId, 'This link has expired — generate a new one from CallRise AI.')
    return json({ ok: true })
  }

  const { error: updateError } = await supabase
    .from('notification_channels')
    .update({
      address: String(chatId),
      verified_at: new Date().toISOString(),
      verification_token: null // single-use: burn it immediately
    })
    .eq('id', channel.id)

  if (updateError) {
    await sendPlain(chatId, "Something went wrong connecting this chat — please try again.")
    return json({ ok: true })
  }

  await sendPlain(chatId, 'Connected ✅ — CallRise AI alerts will be sent to this chat.')
  return json({ ok: true })
})

async function sendPlain(chatId: number, text: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  }).catch(() => {})
}
