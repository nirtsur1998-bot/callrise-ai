// Telegram channel adapter (M19 Task 1).
//
// Verification never asks for a phone number or chat id — Telegram has no
// concept of "enter your address" the way email does. Instead: generate a
// one-time nonce, show a deep link + QR (t.me/<bot>?start=<nonce>); the bot's
// webhook (supabase/functions/telegram-webhook) receives `/start <nonce>` and
// binds the sender's chat_id to this channel row. The nonce is base64url (the
// Telegram start-parameter alphabet is restricted to A-Za-z0-9_- and capped at
// 64 chars — standard base64's `+`/`/`/`=` would break the deep link).

import { randomBytes } from 'node:crypto'

const TELEGRAM_API_BASE = 'https://api.telegram.org'
const NONCE_TTL_MS = 10 * 60_000 // 10 minutes — long enough to open Telegram and tap Start
const MAX_FAILURES_BEFORE_UNHEALTHY = 3

function botToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  return token ? token : null
}

function botUsername(): string | null {
  const username = process.env.TELEGRAM_BOT_USERNAME?.trim()
  return username ? username.replace(/^@/, '') : null
}

/** Base64url, no padding — every character is in Telegram's allowed
 *  start-parameter alphabet (A-Za-z0-9_-). */
export function generateNonce(): string {
  return randomBytes(24).toString('base64url')
}

export function telegramDeepLink(nonce: string): string | null {
  const username = botUsername()
  if (!username) return null
  return `https://t.me/${username}?start=${nonce}`
}

/**
 * MarkdownV2 requires escaping these characters anywhere they appear as
 * literal text (not as markdown syntax): _ * [ ] ( ) ~ ` > # + - = | { } . !
 * An AI-drafted brief or alert body will contain several of these (periods,
 * dashes, parens) and Telegram's sendMessage returns HTTP 400 if they aren't
 * escaped — this is the single most common way a real alert silently never
 * sends.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`)
}

interface TelegramSendResult {
  ok: boolean
  error_code?: number
  description?: string
}

async function callSendMessage(
  chatId: string,
  text: string,
  parseMode: 'MarkdownV2' | undefined
): Promise<TelegramSendResult> {
  const token = botToken()
  if (!token) return { ok: false, description: 'not-configured' }
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true
    })
  })
  return (await res.json()) as TelegramSendResult
}

/** Send with MarkdownV2; on ANY parse_mode-related failure (bad escaping we
 *  missed, an edge case in the escaper), retry once as plain text rather than
 *  dropping the alert outright — a plain-text alert that arrives beats a
 *  perfectly-formatted one that doesn't. */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: 'MarkdownV2' | 'None'
): Promise<{ ok: boolean; message?: string }> {
  const first = await callSendMessage(chatId, text, parseMode === 'MarkdownV2' ? 'MarkdownV2' : undefined)
  if (first.ok) return { ok: true }
  if (parseMode === 'MarkdownV2') {
    // Strip markdown escaping and retry as plain text — the raw AlertMessage
    // body (unescaped) should be passed in by the caller for this fallback;
    // here we best-effort de-escape the already-escaped text.
    const plain = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
    const retry = await callSendMessage(chatId, plain, undefined)
    if (retry.ok) return { ok: true }
    return { ok: false, message: retry.description ?? first.description }
  }
  return { ok: false, message: first.description }
}

export { NONCE_TTL_MS, MAX_FAILURES_BEFORE_UNHEALTHY }
