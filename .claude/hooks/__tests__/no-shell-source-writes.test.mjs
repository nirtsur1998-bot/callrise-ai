// Does the hook refuse the four real incidents, and allow everything routine?
//
// A guard verified only by watching it ALLOW the good case is the gap that made
// bug259-clean-bad-titles.mjs's own guard wrong in both directions. So this
// checks refusal first, on the commands that actually happened, and then checks
// that the day's ordinary traffic still passes.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'no-shell-source-writes.mjs')

function run(command, toolName = 'Bash') {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: { command } })
  try {
    execFileSync(process.execPath, [HOOK], { input: payload, stdio: ['pipe', 'pipe', 'pipe'] })
    return { blocked: false, message: '' }
  } catch (err) {
    return { blocked: err.status === 2, message: String(err.stderr ?? '') }
  }
}

// --- MUST BLOCK: the four that actually happened, plus near neighbours -------
const MUST_BLOCK = [
  // The backtick incident, 2026-09-10. Three words executed as commands and
  // replaced with empty strings; exit code 0.
  `python -c "\nimport io\nP = r'Bug Tracker.md'\ns = io.open(P, encoding='utf8').read()\nio.open(P,'w',encoding='utf8').write(s)\n"`,
  // The heredoc that ended early on an apostrophe.
  `python - <<'PY'\nimport io\nio.open('src/main/calls.ts','w').write('x')\nPY`,
  // A plain redirect over a source file.
  'echo "export const x = 1" > src/main/thing.ts',
  'cat header.md footer.md >> docs/README.md',
  // In-place edits.
  "sed -i 's/foo/bar/' src/renderer/src/App.tsx",
  "perl -i -pe 's/a/b/' src/main/index.ts",
  // Node doing the same thing.
  `node -e "require('fs').writeFileSync('src/main/x.ts','y')"`,
  // PowerShell.
  `pwsh -c "Set-Content -Path src/main/x.ts -Value 'y'"`
]

// --- MUST ALLOW: everything routine, or the hook becomes noise and gets off --
const MUST_ALLOW = [
  // A heredoc feeding STDIN writes no file. This is used on every commit.
  "git commit -q -F- <<'MSG'\nBUG-123: a thing\n\nwith an apostrophe's body\nMSG",
  // Scratchpad scripts are the RECOMMENDED workaround — blocking them would
  // leave no legal way to do this.
  `python "C:/Users/User/AppData/Local/Temp/claude/scratchpad/patch.py"`,
  `python -c "io.open('C:/Users/User/AppData/Local/Temp/x/scratchpad/note.md','w').write('x')"`,
  // Reads of every shape.
  'cat src/main/calls.ts',
  'grep -rn "maxTokens" src/main --include=*.ts',
  'sed -n "1,40p" src/main/call-title.ts',
  // Redirects that are not source files.
  'npm test > /dev/null 2>&1',
  'npm run build > build.log 2>&1',
  'node scripts/verification/thing.mjs > "C:/Users/User/AppData/Local/Temp/out.txt"',
  // Ordinary git and node.
  'git status --short',
  'npx vitest run src/main/__tests__/x.test.ts',
  // Reading a json file is not writing one.
  'node -e "console.log(require(\'./package.json\').version)"'
]

let failures = 0
console.log('MUST BLOCK')
for (const cmd of MUST_BLOCK) {
  const r = run(cmd)
  const ok = r.blocked
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${cmd.replace(/\n/g, ' ').slice(0, 66)}`)
}

console.log('')
console.log('MUST ALLOW')
for (const cmd of MUST_ALLOW) {
  const r = run(cmd)
  const ok = !r.blocked
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${cmd.replace(/\n/g, ' ').slice(0, 66)}`)
}

console.log('')
// A non-Bash tool must pass straight through — the Write tool is the thing this
// hook is telling people to use, and blocking it would be perfect irony.
const write = run('anything at all', 'Write')
if (write.blocked) failures++
console.log(`  ${write.blocked ? 'FAIL' : 'PASS'}  the Write tool itself is never blocked`)

console.log('')
console.log(failures === 0 ? 'hook holds' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
