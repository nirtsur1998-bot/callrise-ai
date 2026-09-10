// BUG-167 landing — how much longer is the MERGED tool description?
//
// The merge kept both instructions: main's CLIENT-category rule and the
// branch's "not-relevant" option. Neither side shipped that combination, so
// nobody has measured it. "Prompt text is behaviour" — but before spending the
// founder's API budget on an extraction eval, the free question is how much
// text actually changed, because that bounds how much the answer can matter.
//
// Compares three versions of the same rendered description:
//   main      (14347d4)      — the client-category rule, no not-relevant
//   branch    (984f36f)      — not-relevant, no client-category rule
//   merged    (working tree) — both
//
// Renders them by substituting the same placeholder values into each template,
// so the comparison is of PROMPT TEXT the model would see, not of source.
import { execFileSync } from 'node:child_process'

const FILE = 'src/main/memory/extraction.ts'
const REPO = process.cwd()

const at = (rev) =>
  rev === 'WORKTREE'
    ? execFileSync('git', ['show', ':' + FILE], { cwd: REPO, encoding: 'utf8' })
    : execFileSync('git', ['show', `${rev}:${FILE}`], { cwd: REPO, encoding: 'utf8' })

/** The `description:` value of the category property, as a single string. */
function describeCategory(src) {
  const i = src.indexOf('enum: [...MEMORY_CATEGORIES')
  if (i < 0) return null
  const j = src.indexOf('description:', i)
  if (j < 0) return null
  // Take everything up to the line that closes this property block.
  const rest = src.slice(j)
  const end = rest.search(/\n\s{12,14}\},?\n/)
  const block = rest.slice(0, end > 0 ? end : 1200)
  // Concatenate the template literals, dropping the JS glue and the ${...}.
  const parts = [...block.matchAll(/`([^`]*)`/g)].map((m) => m[1])
  return parts.join('').replace(/\$\{[^}]+\}/g, '<X>').replace(/\s+/g, ' ').trim()
}

const rows = []
for (const [label, rev] of [
  ['main   ', '14347d4'],
  ['branch ', '984f36f'],
  ['MERGED ', 'WORKTREE']
]) {
  const text = describeCategory(at(rev))
  if (!text) {
    console.log(`${label}: could not extract the description — refusing to guess`)
    continue
  }
  rows.push([label, text])
}

const base = rows.find((r) => r[0].trim() === 'main')?.[1] ?? ''
console.log('CATEGORY DESCRIPTION — the one field the merge changed')
console.log('')
for (const [label, text] of rows) {
  const chars = text.length
  const words = text.split(/\s+/).length
  const approxTokens = Math.round(chars / 4) // rough, and labelled as rough
  const delta = base ? chars - base.length : 0
  console.log(
    `${label} ${String(chars).padStart(5)} chars  ${String(words).padStart(4)} words  ~${String(approxTokens).padStart(4)} tok` +
      (label.trim() === 'main' ? '  (baseline)' : `  ${delta >= 0 ? '+' : ''}${delta} chars vs main`)
  )
}
console.log('')
const merged = rows.find((r) => r[0].trim() === 'MERGED')?.[1]
if (merged) {
  console.log('THE MERGED TEXT, as the model would see it:')
  console.log('')
  console.log('  ' + merged.replace(/(.{92}\s)/g, '$1\n  '))
}
console.log('')
console.log('Token counts are chars/4 and APPROXIMATE — stated so nobody quotes them as measured.')
