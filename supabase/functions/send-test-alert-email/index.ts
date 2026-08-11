// send-test-alert-email — the "Send test alert" button for an already-
// verified email channel (M19 Task 1). Called by the app's main process on
// behalf of a signed-in user; verify_jwt stays ON (default).
//
// Deploy: `supabase functions deploy send-test-alert-email`
// Secrets: RESEND_API_KEY, RESEND_FROM_ADDRESS.

import { json, text } from '../_shared/cors.ts'

interface Body {
  email?: string
}

Deno.serve(async (req) => {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return text('bad request', 400)
  }
  const email = body.email?.trim()
  if (!email) return json({ ok: false, error: 'invalid-input' }, 400)

  const apiKey = Deno.env.get('RESEND_API_KEY')
  const from = Deno.env.get('RESEND_FROM_ADDRESS')
  if (!apiKey || !from) return json({ ok: false, error: 'not-configured' }, 500)

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'CallRise AI — test alert',
      html: '<p>This is a test alert. If you can read this, email delivery is working.</p>',
      text: 'This is a test alert. If you can read this, email delivery is working.'
    })
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    return json({ ok: false, error: 'send-failed', message: msg.slice(0, 300) }, 502)
  }
  return json({ ok: true })
})
