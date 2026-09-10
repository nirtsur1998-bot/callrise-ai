/**
 * M39 — the milestone shot: the app saying something about a REAL buyer that it
 * learned from a previous call.
 *
 * WHAT THIS DOES. Reads the founder's own records where they already sit,
 * renders the app's OWN `CallHistoryList` component with them (the same
 * component the Contact detail page mounts under "Call history", and the same
 * one a Deal page mounts under "Everything with <name>"), and prints the markup
 * so it can be painted by the running app's own stylesheet.
 *
 * WHY THIS SHAPE RATHER THAN RUNNING THE APP ON THE REAL PROFILE. Two reasons,
 * both about not touching the founder's data:
 *   - the M39 build's widened read guard strips the 7 `"someone"` identities in
 *     memory, and BUG-185 rewrites every call file on every sync cycle — so
 *     running this build there would eventually PERSIST those seven rewrites,
 *     which is "anything that rewrites my existing calls" and the founder's
 *     call, not mine;
 *   - copying the records into a sandbox moves 297 real transcripts around the
 *     disk for a picture.
 * Reading and rendering moves nothing and writes nothing. Every open below is a
 * read; there is no write path in this file at all.
 *
 * WHAT IT PROVES. That this component, given these records, renders these
 * sentences. It does NOT prove the Contact page mounts it — that is a separate
 * claim, and `ContactDetail.tsx:370` is where to check it.
 *
 * usage: npx tsx --tsconfig tsconfig.web.json scripts/verification/m39-render-call-history.tsx <callsDir> <contactsDir> <tasksDir> <contactName>
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CallHistoryList } from '../../src/renderer/src/features/contacts/CallHistoryList'

const [callsDir, contactsDir, tasksDir, contactName] = process.argv.slice(2)
if (!callsDir || !contactsDir || !contactName) {
  console.error('usage: m39-render-call-history.tsx <callsDir> <contactsDir> <tasksDir> <contactName>')
  process.exit(1)
}

function readAll<T>(dir: string): T[] {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), 'utf8')) as T]
      } catch {
        return []
      }
    })
}

const contacts = readAll<{ id: string; name: string }>(contactsDir)
const contact = contacts.find((c) => c.name === contactName)
if (!contact) {
  console.error(`no contact named ${JSON.stringify(contactName)}`)
  process.exit(2)
}

type AnyCall = { id: string; contactId?: string; createdAt?: string; deleted?: boolean }
const calls = readAll<AnyCall>(callsDir)
  .filter((c) => !c.deleted && c.contactId === contact.id)
  // Newest first, the same order useContactCallHistory produces.
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))

const tasks = readAll<{ callId?: string }>(tasksDir)
const linked = calls.map((call) => ({
  call,
  tasks: tasks.filter((t) => t.callId === call.id)
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const html = renderToStaticMarkup(
  <CallHistoryList loading={false} linked={linked as any} emptyMessage="No calls with this contact yet." />
)

process.stdout.write(
  JSON.stringify(
    {
      contact: contact.name,
      calls: linked.length,
      withSummary: calls.filter((c) => (c as { summary?: { executive?: string } }).summary?.executive).length,
      html
    },
    null,
    2
  )
)
