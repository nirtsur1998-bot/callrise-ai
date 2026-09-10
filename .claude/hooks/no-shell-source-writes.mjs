#!/usr/bin/env node
/**
 * REFUSE shell writes to source files.
 *
 * WHY THIS EXISTS AS A HOOK AND NOT A README LINE. The rule "write files with
 * the file tool, not through a shell string" has been in
 * scripts/verification/README.md for weeks and has been violated FOUR times.
 * Every one was caught by reading the result, never by the command failing:
 *
 *   - a backticked identifier inside double quotes was EXECUTED, and three
 *     words were silently replaced with empty strings. Exit code 0.
 *   - a heredoc containing an apostrophe ended the quote early, so the shell
 *     reported `unexpected EOF` and wrote nothing — the benign direction.
 *   - `python -c "…'…'…"` nested quotes collapsed.
 *   - a `<<'PY'` block whose body contained `'PY'` terminated early.
 *
 * The founder, 2026-09-10: *"That's not four incidents, that's one unusable
 * instrument used four times... if there's a way for a shell write to a source
 * file to be refused rather than remembered against, that's worth more than a
 * fifth README line."*
 *
 * WHAT IT BLOCKS: a Bash command whose effect is to WRITE a source or document
 * file — a redirect, an in-place edit, or an inline interpreter opening one for
 * writing.
 *
 * WHAT IT DELIBERATELY ALLOWS, because blocking these would make it noise that
 * gets disabled:
 *   - anything under a temp/scratchpad path (that is where throwaway scripts
 *     belong, and writing them there is the recommended workaround)
 *   - `> /dev/null`, `2>&1`, and redirects to .log/.out/.txt
 *   - `git commit -F-` and friends: a heredoc that feeds STDIN writes no file
 *   - reads of any kind
 *
 * FAILS OPEN, and says so. A hook that fails closed on its own bug would block
 * every command in the session; the cost of a false negative here is one
 * caught-by-reading incident, the cost of a false positive is a bricked
 * session. The detection is kept conservative for the same reason.
 */
import { readFileSync } from 'node:fs'

/** Extensions where a silent corruption is expensive and hard to see. */
const SOURCE_EXT =
  '(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|ya?ml|ps1|psm1|inx|inf|vcxproj|sql|sh)'

/** Paths where throwaway scripts belong — the recommended way to do this. */
const SCRATCH = /(?:[\\/]temp[\\/]|[\\/]tmp[\\/]|scratchpad|[\\/]t?mp[\\/]|appdata[\\/]local[\\/]temp)/i

function verdict(command) {
  const cmd = String(command ?? '')
  const reasons = []

  // 1. A redirect whose destination is a source file.
  const redirect = new RegExp(`>>?\\s*["']?([^\\s|&;"']*\\.${SOURCE_EXT})\\b`, 'gi')
  for (const m of cmd.matchAll(redirect)) {
    if (!SCRATCH.test(m[1])) reasons.push(`redirects into ${m[1]}`)
  }

  // 2. In-place edits.
  const inPlace = new RegExp(`\\b(?:sed|perl)\\b[^|;&]*-i\\b[^|;&]*?([^\\s|&;"']*\\.${SOURCE_EXT})\\b`, 'gi')
  for (const m of cmd.matchAll(inPlace)) {
    if (!SCRATCH.test(m[1])) reasons.push(`edits ${m[1]} in place`)
  }

  // 3. An inline interpreter opening something for writing. `python -c`,
  //    `node -e`, and `python -` / `node -` fed by a heredoc are all the same
  //    hazard: the script is a SHELL STRING first and a program second, so
  //    every quote in it is the shell's before it is the language's.
  const inlineInterp = /\b(?:python|python3|node|pwsh|powershell)\b\s+(?:-c|-e|-)\s/i.test(cmd)
  const writesAFile =
    /\.write\s*\(|writeFileSync|open\s*\([^)]*['"][wa]\+?['"]|Set-Content|Out-File|io\.open\s*\([^)]*['"][wa]/i.test(cmd)
  if (inlineInterp && writesAFile && !SCRATCH.test(cmd)) {
    reasons.push('runs an inline interpreter that opens a file for writing')
  }

  return reasons
}

let payload
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0) // fail open — see the header
}

if (payload?.tool_name !== 'Bash') process.exit(0)

let reasons = []
try {
  reasons = verdict(payload?.tool_input?.command)
} catch (err) {
  process.stderr.write(`[no-shell-source-writes] hook errored, ALLOWING: ${err.message}\n`)
  process.exit(0)
}

if (reasons.length === 0) process.exit(0)

process.stderr.write(
  [
    'BLOCKED: this command writes a source file through the shell.',
    ...reasons.map((r) => `  - it ${r}`),
    '',
    'Four times on this project a shell-quoted write has silently corrupted the',
    'file it was writing — a backticked identifier inside double quotes is executed,',
    'a heredoc ends early on an apostrophe — and every one was caught by reading the',
    'result afterwards, never by the command failing. Exit code 0, file almost right.',
    '',
    'Use the Write or Edit tool instead. If a script is genuinely needed, write it',
    'to the scratchpad first and run the FILE — this hook allows that.',
    '',
    '(Reads are fine. `git commit -F-` is fine. Redirects to logs are fine.)'
  ].join('\n') + '\n'
)
process.exit(2)
