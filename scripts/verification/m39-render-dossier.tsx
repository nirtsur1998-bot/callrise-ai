/**
 * M39 — show the client dossier as the model receives it, for a real buyer.
 *
 * READ-ONLY. The founder's records are read where they sit; nothing is copied
 * and nothing is written. The output is the EXACT string the live cue puts at
 * the front of its prompt, rendered as monospace so it can be read rather than
 * described.
 *
 * usage: npx tsx --tsconfig tsconfig.node.json scripts/verification/m39-render-dossier.tsx <profileDir> <contactName>
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildClientDossier } from '../../src/main/live/clientDossier'

const [PROFILE, NAME] = process.argv.slice(2)
if (!PROFILE || !NAME) {
  console.error('usage: m39-render-dossier.tsx <profileDir> <contactName>')
  process.exit(1)
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function readAll(dir: string): any[] {
  const p = join(PROFILE, dir)
  if (!existsSync(p)) return []
  return readdirSync(p)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(p, f), 'utf8'))]
      } catch {
        return []
      }
    })
}

const contact = readAll('contacts').find((c) => c.name === NAME)
if (!contact) {
  console.error(`no contact named ${JSON.stringify(NAME)}`)
  process.exit(2)
}
const calls = readAll('calls')
const deals = readAll('deals')
const d = buildClientDossier({
  contact,
  deal: deals.find((x) => x.contactId === contact.id) ?? null,
  stageLabel: null,
  calls,
  tasks: readAll('tasks'),
  objections: readAll('objection-queue'),
  asOf: new Date().toISOString()
})

const html = renderToStaticMarkup(
  <div style={{ maxWidth: 900, margin: '0 auto' }}>
    <h2 style={{ font: '600 17px/1.3 system-ui', margin: '0 0 4px', color: 'var(--color-ink)' }}>
      What the coach knows about {contact.name} before the call starts
    </h2>
    <p style={{ font: '400 12px/1.4 system-ui', margin: '0 0 16px', color: 'var(--color-muted)' }}>
      {d.chars} characters, assembled once and frozen for the call. This exact string goes at the
      front of every live cue.
    </p>
    <pre
      style={{
        font: '400 12px/1.65 ui-monospace, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        margin: 0,
        padding: '16px 18px',
        borderRadius: 12,
        border: '1px solid var(--color-line-soft)',
        background: 'var(--color-surface)',
        color: 'var(--color-ink)'
      }}
    >
      {d.text}
    </pre>
  </div>
)

process.stdout.write(JSON.stringify({ contact: contact.name, chars: d.chars, sections: d.sections, html }, null, 2))
