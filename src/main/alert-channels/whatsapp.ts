// WhatsApp channel adapter (M19 Task 1) — scaffolded, disabled in UI.
//
// The Meta Cloud API call itself is fully written below so wiring it up later
// is a credentials-and-flag change, not a rewrite. It returns 'not-configured'
// until WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN are set, which they
// deliberately never are in this milestone (needs Meta Business verification
// + template approval — see docs/whatsapp-setup.md). The UI shows this
// channel greyed out with "Coming soon" regardless of env state.

import type { DeliveryResult } from './types'

const GRAPH_API_BASE = 'https://graph.facebook.com/v20.0'

function isConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() && process.env.WHATSAPP_ACCESS_TOKEN?.trim())
}

export interface WhatsAppTemplateMessage {
  to: string // E.164
  templateName: string
  language: string // e.g. 'en_US'
  components: unknown[]
}

/**
 * Send a pre-approved template message via the Meta Cloud API. Business-
 * initiated messages outside the 24-hour customer-service window REQUIRE a
 * pre-approved template — a reminder is a Utility-category template (see
 * docs/whatsapp-setup.md for the exact text submitted for approval).
 */
export async function sendWhatsAppTemplate(msg: WhatsAppTemplateMessage): Promise<DeliveryResult> {
  if (!isConfigured()) {
    return { ok: false, error: 'not-configured' }
  }
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!.trim()
  const token = process.env.WHATSAPP_ACCESS_TOKEN!.trim()
  try {
    const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: msg.to,
        type: 'template',
        template: {
          name: msg.templateName,
          language: { code: msg.language },
          components: msg.components
        }
      })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: 'send-failed', message: body.slice(0, 300) }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: 'send-failed', message: err instanceof Error ? err.message : 'unknown error' }
  }
}

export function whatsAppStatus(): { configured: boolean } {
  return { configured: isConfigured() }
}
