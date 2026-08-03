// send-verification-email — sends the 6-digit double-opt-in code for a new
// email alert channel (M19 Task 1). Called by the desktop app's main process
// (via the authenticated Supabase client, so this DOES verify the JWT — it's
// only ever invoked by a signed-in user acting on their own channel).
//
// Deploy: `supabase functions deploy send-verification-email`
// (verify_jwt stays ON — default — since this is called by the app on
// behalf of a signed-in user, unlike the webhooks which have no JWT at all.)
//
// Secrets: RESEND_API_KEY, RESEND_FROM_ADDRESS (same as alert-dispatcher).

import { json, text } from '../_shared/cors.ts'

interface Body {
  email?: string
  code?: string
}

Deno.serve(async (req) => {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return text('bad request', 400)
  }
  const email = body.email?.trim()
  const code = body.code?.trim()
  if (!email || !code || !/^\d{6}$/.test(code)) {
    return json({ ok: false, error: 'invalid-input' }, 400)
  }

  const apiKey = Deno.env.get('RESEND_API_KEY')
  const from = Deno.env.get('RESEND_FROM_ADDRESS')
  if (!apiKey || !from) {
    return json({ ok: false, error: 'not-configured' }, 500)
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'Confirm your CallRise AI email alerts',
      html: `<p>Your verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>This code expires in 15 minutes.</p>`,
      text: `Your CallRise AI verification code is: ${code}\n\nThis code expires in 15 minutes.`
    })
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    return json({ ok: false, error: 'send-failed', message: msg.slice(0, 300) }, 502)
  }
  return json({ ok: true })
})
