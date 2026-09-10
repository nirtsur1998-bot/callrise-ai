// M39 — launch the app against a SANDBOX profile, on a chosen debug port, and
// print the PID that must own that port.
//
// Species 110 has cost this project an hour twice: an instance from an earlier
// session holds the debug port, the new launch fails to bind, exits quietly,
// and every subsequent reading comes from the wrong build. So this refuses to
// start if anything is already listening, and prints the PID for expectPid.
//
// usage: node scripts/verification/m39-launch-sandbox.mjs <port> <userDataDir>
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const PORT = Number(process.argv[2] || 9347)
const DIR = process.argv[3]
if (!DIR) {
  console.error('usage: m39-launch-sandbox.mjs <port> <userDataDir>')
  process.exit(1)
}
if (!/temp|tmp|sandbox/i.test(DIR)) {
  console.error(`REFUSING: ${DIR} does not look like a temp/sandbox path.`)
  process.exit(1)
}

function owner(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
  } catch {
    /* fall through */
  }
  return null
}

const held = owner(PORT)
if (held !== null) {
  console.error(`REFUSING: PID ${held} already LISTENS on ${PORT}. Kill it first — a launch that`)
  console.error('  cannot bind exits quietly and every reading would come from the wrong build.')
  process.exit(2)
}

mkdirSync(DIR, { recursive: true })
// shell: true — Node 20+ refuses to spawn a .cmd shim directly on Windows
// (EINVAL), and npx is a .cmd here.
const child = spawn(
  'npx electron-vite dev -- --remote-debugging-port=' + PORT,
  {
    cwd: process.cwd(),
    env: { ...process.env, CALLRISE_USER_DATA_DIR: DIR, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: 'inherit',
    shell: true,
    detached: false
  }
)
console.log(`[launch] spawned npx electron-vite dev (wrapper pid ${child.pid})`)
console.log(`[launch] CALLRISE_USER_DATA_DIR=${DIR}`)
console.log(`[launch] debug port ${PORT} — poll for the OWNING pid with netstat, not this pid`)
child.on('exit', (code) => {
  console.log(`[launch] dev server exited with ${code}`)
  process.exit(code ?? 0)
})
