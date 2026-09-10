/**
 * BUG-261 — the runner. Do the app's TIGHT-CEILING TOOL CALLS survive a
 * reasoning model, or does the whole budget go to thinking?
 *
 * BUG-259 found that gpt-oss-20b/120b spend 80-199 output tokens before
 * answering, and that at a 60-token ceiling they return EMPTY CONTENT with
 * finish_reason "length". The founder's follow-up: does anything else in the
 * app have a ceiling low enough to hit this?
 *
 * Six sites do, and every one of them uses a TOOL:
 *
 *   live-cue.ts:84            100   pace cue
 *   live-cue.ts:502           150   the live coaching cue
 *   contact-intelligence:232  150   contact detection
 *   consolidation.ts:73       200   judgeSameFact       <- BUG-258's suspect
 *   consolidation.ts:176      200   contradiction judge
 *   assistant/tools.ts:230    200   propose task
 *
 * The failure is worse than a truncated answer. Every one of these treats "no
 * tool call came back" as an ANSWER rather than a failure: judgeSameFact's
 * `catch { return false }` asserts NON-IDENTITY, so a reasoning model that
 * never emits a tool call silently creates a duplicate memory and looks like
 * it decided.
 *
 * Measured with the real tool schemas at the real ceilings.
 */
const https = require('node:https')

const CASES = [
  { site: 'live-cue.ts:84 (pace cue)', ceiling: 100 },
  { site: 'live-cue.ts:502 (live cue)', ceiling: 150 },
  { site: 'consolidation.ts:73 (judgeSameFact)', ceiling: 200 }
]

/** The real merge-judge tool, copied from consolidation.ts. A boolean — the
 *  smallest possible answer, so if THIS cannot fit, nothing tighter can. */
const MERGE_JUDGE_TOOL = {
  type: 'function',
  function: {
    name: 'judge_same_fact',
    description: 'Decide whether two statements express the same underlying fact.',
    parameters: {
      type: 'object',
      properties: { sameFact: { type: 'boolean', description: 'True if these are the same underlying fact.' } },
      required: ['sameFact']
    }
  }
}

const PROMPT =
  'Statement A: "The buyer\'s CFO signs off on anything above forty thousand."\n' +
  'Statement B: "Purchases over 40k need CFO approval at this company."\n\n' +
  'Are these the same underlying fact?'

const MODELS = [
  { label: 'gpt-oss-120b (groq)', key: 'GROQ', host: 'api.groq.com', path: '/openai/v1/chat/completions', model: 'openai/gpt-oss-120b' },
  { label: 'gpt-oss-20b (groq)', key: 'GROQ', host: 'api.groq.com', path: '/openai/v1/chat/completions', model: 'openai/gpt-oss-20b' },
  { label: 'qwen3.8-27b (groq)', key: 'GROQ', host: 'api.groq.com', path: '/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b' },
  { label: 'nemotron-3.5-lightning:free (or)', key: 'OPENROUTER', host: 'openrouter.ai', path: '/api/v1/chat/completions', model: 'nvidia/nemotron-3.5-lightning:free' }
]

function post(host, path, key, body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: host,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = ''
        res.on('data', (d) => (raw += d))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            let why = raw.slice(0, 100)
            try {
              const j = JSON.parse(raw)
              why = `${j.error?.code ?? '?'}: ${String(j.error?.message ?? '').slice(0, 80)}`
            } catch {
              /* keep raw */
            }
            resolve({ ok: false, err: `HTTP ${res.statusCode} ${why}` })
            return
          }
          try {
            const j = JSON.parse(raw)
            const c = j.choices?.[0]
            const calls = c?.message?.tool_calls ?? []
            resolve({
              ok: true,
              toolCalled: calls.length > 0,
              finish: c?.finish_reason ?? '?',
              outTokens: j.usage?.completion_tokens ?? null,
              content: String(c?.message?.content ?? '').trim(),
              reasoning: String(c?.message?.reasoning ?? '').trim()
            })
          } catch {
            resolve({ ok: false, err: 'unparseable' })
          }
        })
      }
    )
    req.on('error', (e) => resolve({ ok: false, err: e.message }))
    req.write(payload)
    req.end()
  })
}

async function main() {
  console.log('BUG-261 — do the app’s tight-ceiling TOOL calls survive a reasoning model?')
  console.log('')
  console.log('  The merge judge’s tool: one boolean. The smallest answer the app ever asks')
  console.log('  for — if this does not fit, nothing tighter does.')
  console.log('')
  console.log('  model                             ceiling   out  finish    tool call?')
  console.log('  ' + '-'.repeat(72))

  const failures = []
  for (const m of MODELS) {
    const key = process.env[`BUG261_${m.key}`]
    if (!key) {
      console.log(`  ${m.label.padEnd(33)} SKIPPED — no ${m.key} key`)
      continue
    }
    for (const c of CASES) {
      const r = await post(m.host, m.path, key, {
        model: m.model,
        max_tokens: c.ceiling,
        tools: [MERGE_JUDGE_TOOL],
        tool_choice: { type: 'function', function: { name: 'judge_same_fact' } },
        messages: [{ role: 'user', content: PROMPT }]
      })
      if (!r.ok) {
        console.log(`  ${m.label.padEnd(33)} ${String(c.ceiling).padStart(6)}   ERROR ${r.err}`)
        continue
      }
      const verdict = r.toolCalled ? 'YES' : 'NO  <-- silent wrong answer'
      if (!r.toolCalled) failures.push({ model: m.label, ceiling: c.ceiling, site: c.site })
      console.log(
        `  ${m.label.padEnd(33)} ${String(c.ceiling).padStart(6)}  ${String(r.outTokens ?? '?').padStart(4)}  ` +
          `${String(r.finish).padEnd(8)}  ${verdict}`
      )
    }
  }

  console.log('')
  console.log('  READ')
  console.log('  ' + '-'.repeat(72))
  if (failures.length === 0) {
    console.log('  Every model returned a tool call at every ceiling in use. The tight')
    console.log('  ceilings are NOT a second instance of BUG-259 — titles were special')
    console.log('  because the answer itself is prose, not a tool call.')
  } else {
    console.log(`  ${failures.length} (model, ceiling) combination(s) returned NO TOOL CALL.`)
    console.log('  Each one is a SILENT WRONG ANSWER at the call site, not an error:')
    console.log('    judgeSameFact       -> catch/false -> "different fact" -> duplicate memory')
    console.log('    live cue            -> cue "none"  -> the rep is told nothing is happening')
    console.log('    contact detection   -> no contact  -> the call stays unlinked')
    for (const f of failures) console.log(`      ${f.model} @${f.ceiling}  (${f.site})`)
  }
  return 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    process.stderr.write('run failed: ' + (e && e.stack ? e.stack : String(e)) + '\n')
    process.exit(1)
  }
)
