/**
 * BUG-258 — the funnel itself. Spawned by bug258-merge-funnel.cjs with the API
 * key in its ENVIRONMENT and nowhere else.
 *
 * Replays consolidateNewCandidate's gates in their real order over the real
 * stored vectors, treating each existing memory as if it had just arrived as a
 * candidate against the ones that existed before it.
 */
const Database = require('better-sqlite3')
const sqliteVec = require('sqlite-vec')
const https = require('node:https')
const { join } = require('node:path')

const DB_PATH = join(process.env.APPDATA || '', 'sales-os', 'memory.db')
const MAX_JUDGE = Number(process.argv[2] || 60)

// The three constants copied from the shipped source. Printed below so a drift
// between this harness and consolidation.ts is visible rather than silent.
const DUPLICATE_VECTOR_DISTANCE_THRESHOLD = 0.35
const NEARBY_LIMIT = 3 // consolidateNewCandidate passes `limit: 3`
const MODEL = 'claude-sonnet-4-6'

const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

const MERGE_JUDGE_TOOL = {
  name: 'judge_same_fact',
  description: 'Decide whether two statements express the same underlying fact.',
  input_schema: {
    type: 'object',
    properties: { sameFact: { type: 'boolean', description: 'True if these are the same underlying fact.' } },
    required: ['sameFact']
  }
}

function judgeSameFact(key, a, b) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 200,
    tools: [MERGE_JUDGE_TOOL],
    tool_choice: { type: 'tool', name: 'judge_same_fact' },
    messages: [{ role: 'user', content: `Statement A: "${a}"\nStatement B: "${b}"\n\nAre these the same underlying fact?` }]
  })
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': key,
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let raw = ''
        res.on('data', (d) => (raw += d))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            // The BODY, not just the status. 12 consecutive 400s is a cause,
            // not noise, and reporting them as production evidence without
            // knowing which cause would be a fabricated mechanism.
            let why = ''
            try {
              const j = JSON.parse(raw)
              why = `${j.error?.type ?? '?'}: ${String(j.error?.message ?? '').slice(0, 90)}`
            } catch {
              why = raw.slice(0, 90)
            }
            resolve({ ok: false, sameFact: false, err: `HTTP ${res.statusCode} ${why}` })
            return
          }
          try {
            const parsed = JSON.parse(raw)
            const tool = (parsed.content || []).find((c) => c.type === 'tool_use')
            resolve({ ok: Boolean(tool), sameFact: tool?.input?.sameFact === true })
          } catch {
            resolve({ ok: false, sameFact: false, err: 'unparseable' })
          }
        })
      }
    )
    req.on('error', (e) => resolve({ ok: false, sameFact: false, err: e.message }))
    req.write(body)
    req.end()
  })
}

async function main() {
  const key = process.env.BUG258_KEY
  if (!key) throw new Error('no key in env')

  const db = new Database(DB_PATH, { readonly: true })
  sqliteVec.load(db)

  const mems = db
    .prepare('SELECT rowid_pk, id, scope, statement, status, created_at FROM memories ORDER BY created_at ASC')
    .all()

  console.log('BUG-258 — where does the merge funnel actually die?')
  console.log('')
  console.log(`  memories          ${mems.length}`)
  console.log(`  scopes            ${new Set(mems.map((m) => m.scope)).size}`)
  console.log(`  gate constants    k=${NEARBY_LIMIT}, distance<=${DUPLICATE_VECTOR_DISTANCE_THRESHOLD}, model ${MODEL}`)
  console.log('')
  console.log('  Each memory is replayed as if it had just arrived, against only')
  console.log('  those that existed BEFORE it — the same population the real run saw.')
  console.log('')

  // --- GATE 1: exact normalized statement match, same scope ----------------
  let exact = 0
  for (let i = 0; i < mems.length; i++) {
    const prior = mems.slice(0, i).filter((p) => p.scope === mems[i].scope)
    if (prior.some((p) => normalize(p.statement) === normalize(mems[i].statement))) exact++
  }

  // --- GATE 2: what the REAL query surfaces --------------------------------
  // sqlite-vec applies `k` across the whole table, THEN SQL filters by scope.
  // Replayed exactly, including that ordering.
  const knn = db.prepare(`
    SELECT v.rowid AS rowid, v.distance AS distance
    FROM vec_memories v
    WHERE v.embedding MATCH (SELECT embedding FROM vec_memories WHERE rowid = ?) AND k = ?
    ORDER BY v.distance
  `)
  // The same question without the k-then-filter problem: the nearest neighbour
  // that is actually IN SCOPE, however far down the global ranking it sits.
  const knnWide = db.prepare(`
    SELECT v.rowid AS rowid, v.distance AS distance
    FROM vec_memories v
    WHERE v.embedding MATCH (SELECT embedding FROM vec_memories WHERE rowid = ?) AND k = ?
    ORDER BY v.distance
  `)

  const byRowid = new Map(mems.map((m) => [m.rowid_pk, m]))
  const order = new Map(mems.map((m, i) => [m.rowid_pk, i]))

  let survivedRealQuery = 0 // had >=1 in-scope, earlier neighbour in the global top-3
  let withinThreshold = 0 // ...and inside 0.35
  let hadInScopeNeighbourAtAll = 0 // an in-scope earlier neighbour exists somewhere
  let inScopeWithinThreshold = 0 // ...and it is inside 0.35
  const judgePairs = []
  const wideJudgePairs = []

  for (const m of mems) {
    const i = order.get(m.rowid_pk)
    if (i === 0) continue

    // (a) THE REAL QUERY: global top-3, then keep only earlier + same scope.
    const top = knn.all(m.rowid_pk, NEARBY_LIMIT + 1).filter((r) => r.rowid !== m.rowid_pk)
    const realSurvivors = top
      .slice(0, NEARBY_LIMIT)
      .map((r) => ({ ...r, mem: byRowid.get(r.rowid) }))
      .filter((r) => r.mem && r.mem.scope === m.scope && order.get(r.rowid) < i)
    if (realSurvivors.length) survivedRealQuery++
    const realInside = realSurvivors.filter((r) => r.distance <= DUPLICATE_VECTOR_DISTANCE_THRESHOLD)
    if (realInside.length) {
      withinThreshold++
      judgePairs.push({ a: m, b: realInside[0].mem, d: realInside[0].distance })
    }

    // (b) THE SAME QUESTION WITHOUT THE k-THEN-FILTER: scan the whole table.
    const all = knnWide
      .all(m.rowid_pk, mems.length)
      .filter((r) => r.rowid !== m.rowid_pk)
      .map((r) => ({ ...r, mem: byRowid.get(r.rowid) }))
      .filter((r) => r.mem && r.mem.scope === m.scope && order.get(r.rowid) < i)
    if (all.length) hadInScopeNeighbourAtAll++
    const wideInside = all.filter((r) => r.distance <= DUPLICATE_VECTOR_DISTANCE_THRESHOLD)
    if (wideInside.length) {
      inScopeWithinThreshold++
      if (!realInside.length) wideJudgePairs.push({ a: m, b: wideInside[0].mem, d: wideInside[0].distance })
    }
  }

  const n = mems.length - 1
  console.log('  THE FUNNEL, as the shipped code runs it')
  console.log('  ' + '-'.repeat(68))
  console.log(`  candidates replayed (all but the first)          ${String(n).padStart(4)}`)
  console.log(`  GATE 1  exact same-scope statement match         ${String(exact).padStart(4)}`)
  console.log(`  GATE 2  global top-${NEARBY_LIMIT} contained an in-scope,`)
  console.log(`          earlier neighbour to even consider       ${String(survivedRealQuery).padStart(4)}`)
  console.log(`  GATE 3  ...and it was within ${DUPLICATE_VECTOR_DISTANCE_THRESHOLD}                 ${String(withinThreshold).padStart(4)}`)
  console.log(`          -> pairs that ever REACHED the judge     ${String(judgePairs.length).padStart(4)}`)
  console.log('')
  console.log('  THE SAME QUESTION WITHOUT THE k-THEN-FILTER ORDERING')
  console.log('  ' + '-'.repeat(68))
  console.log(`  had ANY in-scope earlier neighbour               ${String(hadInScopeNeighbourAtAll).padStart(4)}`)
  console.log(`  ...within ${DUPLICATE_VECTOR_DISTANCE_THRESHOLD}                                  ${String(inScopeWithinThreshold).padStart(4)}`)
  console.log(`  pairs the real query HID from the judge          ${String(wideJudgePairs.length).padStart(4)}`)
  console.log('')

  // --- THE NEAR-MISS SWEEP -------------------------------------------------
  //
  // The funnel dies at the DISTANCE gate, so the question that decides the fix
  // is whether 0.35 is excluding pairs that are genuinely the same fact. Ask
  // the judge about the closest in-scope pairs REGARDLESS of the threshold and
  // print the verdict against the distance. If it says "same fact" at 0.45, the
  // threshold is demonstrably too tight and the data says where to put it. If
  // it says "different" all the way down, the facts really are distinct and the
  // threshold is innocent — which is a different bug entirely.
  const nearMiss = []
  for (const m of mems) {
    const i = order.get(m.rowid_pk)
    if (i === 0) continue
    const all = knnWide
      .all(m.rowid_pk, mems.length)
      .filter((r) => r.rowid !== m.rowid_pk)
      .map((r) => ({ ...r, mem: byRowid.get(r.rowid) }))
      .filter((r) => r.mem && r.mem.scope === m.scope && order.get(r.rowid) < i)
    if (all.length) nearMiss.push({ a: m, b: all[0].mem, d: all[0].distance })
  }
  nearMiss.sort((x, y) => x.d - y.d)

  const q = (p) =>
    nearMiss.length
      ? nearMiss[Math.min(nearMiss.length - 1, Math.max(0, Math.ceil((p / 100) * nearMiss.length) - 1))].d
      : null
  console.log('  NEAREST IN-SCOPE NEIGHBOUR — the distance distribution the gate sees')
  console.log('  ' + '-'.repeat(68))
  console.log(`  n=${nearMiss.length}   min ${q(0)?.toFixed(3)}   p25 ${q(25)?.toFixed(3)}   p50 ${q(50)?.toFixed(3)}   p75 ${q(75)?.toFixed(3)}   max ${q(100)?.toFixed(3)}`)
  console.log(`  inside the 0.35 gate: ${nearMiss.filter((p) => p.d <= 0.35).length} of ${nearMiss.length}`)
  console.log('')

  // --- GATE 4: the judge, on everything that got near ----------------------
  const toJudge = [...judgePairs, ...wideJudgePairs].slice(0, MAX_JUDGE)
  if (toJudge.length === 0) {
    console.log('  GATE 4  the judge was never reachable — nothing to ask it.')
  } else {
    console.log(`  GATE 4  asking the real judge about ${toJudge.length} pair(s)...`)
    let same = 0
    let failed = 0
    for (const p of toJudge) {
      const r = await judgeSameFact(key, p.a.statement, p.b.statement)
      if (!r.ok) failed++
      else if (r.sameFact) same++
    }
    console.log('')
    console.log(`          judged the SAME fact   ${same} of ${toJudge.length}`)
    console.log(`          judged different       ${toJudge.length - same - failed}`)
    console.log(`          the CALL failed        ${failed}  <- each of these is a silent duplicate in production`)
    console.log('')
    console.log(`  Of those, ${judgePairs.slice(0, MAX_JUDGE).length} were pairs the shipped query would actually have`)
    console.log(`  surfaced; ${Math.min(wideJudgePairs.length, Math.max(0, MAX_JUDGE - judgePairs.length))} were pairs it hid.`)
  }

  // --- THE NUMBER THAT DECIDES THE THRESHOLD -------------------------------
  const sweep = nearMiss.slice(0, MAX_JUDGE)
  if (sweep.length) {
    console.log('')
    console.log(`  NEAR-MISS SWEEP — the judge on the ${sweep.length} closest in-scope pairs, threshold IGNORED`)
    console.log('  ' + '-'.repeat(68))
    console.log('   distance   scope            judge says')
    let sameBeyond = 0
    let maxSameDistance = null
    let judgeFailed = 0
    for (const p of sweep) {
      const r = await judgeSameFact(key, p.a.statement, p.b.statement)
      const verdict = !r.ok ? `CALL FAILED (${r.err ?? '?'})` : r.sameFact ? 'SAME FACT' : 'different'
      if (!r.ok) judgeFailed++
      if (r.ok && r.sameFact) {
        if (p.d > DUPLICATE_VECTOR_DISTANCE_THRESHOLD) sameBeyond++
        if (maxSameDistance === null || p.d > maxSameDistance) maxSameDistance = p.d
      }
      console.log(`   ${p.d.toFixed(3).padStart(8)}   ${String(p.a.scope).slice(0, 14).padEnd(16)} ${verdict}`)
    }
    console.log('')
    console.log(`  SAME-FACT pairs the 0.35 gate EXCLUDED: ${sameBeyond}`)
    console.log(`  furthest distance the judge still called the same fact: ${maxSameDistance === null ? 'n/a — it never did' : maxSameDistance.toFixed(3)}`)
    console.log(`  judge call failures during this sweep: ${judgeFailed}`)
    console.log('')
    if (sameBeyond === 0) {
      console.log('  READ: the threshold is INNOCENT. Every pair it excluded, the judge')
      console.log('  also called different. Raising it would merge things that are not')
      console.log('  the same fact. The zero merges are the data, not a bug in the gate.')
    } else {
      console.log(`  READ: the threshold is TOO TIGHT. ${sameBeyond} genuine same-fact pair(s)`)
      console.log(`  never reached the judge. An empirical gate sits above ${maxSameDistance.toFixed(3)}.`)
    }
  }

  console.log('')
  console.log('  Distances are from the STORED vectors — the exact ones the app used.')
  console.log('  No statement text is printed anywhere in this output.')
  db.close()
  return 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    process.stderr.write('funnel failed: ' + (e && e.stack ? e.stack : String(e)) + '\n')
    process.exit(1)
  }
)
