// BUG-234 probe — what does a structured-output response ACTUALLY look like?
//
// The baseline measured 0/6 adherence on the structured arm, with title and
// tasks returning 200 and coach returning 400. A 200 the parser cannot read is
// a parsing bug, not a model limitation, and a 0% rate is too clean to be
// anything else. This dumps the raw response so the fix is made against what
// the API returns rather than against what I assumed it returns.
//
// Two calls. Costs about a tenth of a cent.
import Anthropic from '@anthropic-ai/sdk'
import { TITLE_TOOL } from '../../src/main/call-title'
import { buildCoachTool } from '../../src/main/coach'

const key = process.env.ANTHROPIC_API_KEY?.trim()
if (!key) {
  console.error('ANTHROPIC_API_KEY not set in this process')
  process.exit(2)
}
const client = new Anthropic({ apiKey: key })
const MODEL = 'claude-haiku-4-5'

async function probeSimple(): Promise<void> {
  console.log('\n=== A. simple schema, output_config ===')
  try {
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: 'Give this call a short title. Call: Acme renewal pricing discussion with Dana.' }],
        output_config: {
          format: { type: 'json_schema', schema: TITLE_TOOL.inputSchema as Record<string, unknown> }
        }
      } as Anthropic.MessageCreateParams,
      { maxRetries: 0 }
    )
    const r = res as unknown as Record<string, unknown>
    console.log('top-level keys :', Object.keys(r).join(', '))
    console.log('stop_reason    :', r.stop_reason)
    console.log('has parsed_output:', 'parsed_output' in r, '->', JSON.stringify(r.parsed_output))
    console.log('content blocks :', JSON.stringify(res.content, null, 2).slice(0, 900))
  } catch (err) {
    const e = err as { status?: number; message?: string }
    console.log('THREW status=', e.status, '\n', String(e.message).slice(0, 1200))
  }
}

async function probeComplex(): Promise<void> {
  console.log('\n=== B. complex schema, output_config (the 400) ===')
  const tool = buildCoachTool(false)
  try {
    await client.messages.create(
      {
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: 'Coach this call. Speaker 0: hi. Speaker 1: hello, about pricing.' }],
        output_config: {
          format: { type: 'json_schema', schema: tool.inputSchema as Record<string, unknown> }
        }
      } as Anthropic.MessageCreateParams,
      { maxRetries: 0 }
    )
    console.log('no error — the 400 is situational')
  } catch (err) {
    const e = err as { status?: number; message?: string }
    console.log('THREW status=', e.status)
    console.log('FULL MESSAGE:\n', String(e.message).slice(0, 2000))
  }
}

void (async () => {
  await probeSimple()
  await probeComplex()
})()
