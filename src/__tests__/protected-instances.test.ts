// The one-writer rule as a mechanism (M36, 2026-09-06). Three months of
// convention produced two violations; the second killed the founder's dev
// app while a session cleared its own sandbox. These pin the classification
// and the refusal, with fake process rows — the OS parts are not exercised.
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — an .mjs script with no declaration file; the shape is asserted below
import { classify, stopMatching } from '../../scripts/verification/protected-instances.mjs'

const devApp = { pid: 1, name: 'electron.exe', commandLine: 'C:\\w\\callrise-m34\\node_modules\\electron\\dist\\electron.exe C:\\w\\callrise-m34\\out\\main\\index.js --remote-debugging-port=9333' }
const devChild = { pid: 2, name: 'electron.exe', commandLine: 'C:\\w\\callrise-m34\\node_modules\\electron\\dist\\electron.exe --type=renderer' }
const devServer = { pid: 3, name: 'node.exe', commandLine: 'node C:\\w\\callrise-m34\\node_modules\\electron-vite\\bin\\electron-vite.js dev' }
const installed = { pid: 4, name: 'CallRiseAI.exe', commandLine: 'C:\\Users\\x\\AppData\\Local\\Programs\\CallRiseAI\\CallRiseAI.exe' }
const sandboxBundle = { pid: 5, name: 'electron.exe', commandLine: 'C:\\w\\callrise-m34\\node_modules\\electron\\dist\\electron.exe C:\\w\\callrise-m34\\out-sandbox\\main\\index.js --remote-debugging-port=9334' }
const sandboxProfile = { pid: 6, name: 'electron.exe', commandLine: 'electron.exe out\\main\\index.js --remote-debugging-port=9334 CALLRISE_USER_DATA_DIR=C:\\t\\sandbox-profile-x' }
const unrelated = { pid: 7, name: 'node.exe', commandLine: 'node scripts/verification/verify-green.mjs' }

describe('classify — what is meant to survive', () => {
  it('the dev app on 9333, its children, the dev server and the installed app are PROTECTED', () => {
    expect(classify(devApp).protectedBy).toBe('dev app')
    expect(classify(devChild).protectedBy).toBe('unmarked electron')
    expect(classify(devServer).protectedBy).toBe('dev server')
    expect(classify(installed).protectedBy).toBe('installed app')
  })
  it('a sandbox bundle or a sandbox profile on another port is fair game', () => {
    expect(classify(sandboxBundle).protectedBy).toBeNull()
    expect(classify(sandboxProfile).protectedBy).toBeNull()
  })
  it('a sandbox profile that still claims 9333 is protected — the port is the writer', () => {
    expect(classify({ ...sandboxProfile, commandLine: sandboxProfile.commandLine.replace('9334', '9333') }).protectedBy).toBe('dev app')
  })
  it('anything else is not a CallRise process', () => {
    expect(classify(unrelated)).toEqual({ protectedBy: null, reason: 'not a CallRise process' })
  })
})

describe('stopMatching — the refusal', () => {
  const rows = [devApp, devChild, devServer, installed, sandboxBundle, sandboxProfile]
  it('the exact sweep that killed the dev app on 2026-09-06 now stops only the sandboxes', () => {
    const kill = vi.fn()
    const res = stopMatching(rows, (r: { commandLine: string }) => /callrise-m34/.test(r.commandLine) || /electron/i.test(r.name), { kill })
    expect(kill.mock.calls.map((c) => c[0])).toEqual([5, 6])
    expect(res.refused.map((r: { pid: number }) => r.pid)).toEqual([1, 2, 3])
  })
  it('the installed app is refused even when named directly', () => {
    const kill = vi.fn()
    const res = stopMatching(rows, (r: { pid: number }) => r.pid === 4, { kill })
    expect(kill).not.toHaveBeenCalled()
    expect(res.refused[0]).toMatchObject({ pid: 4, protectedBy: 'installed app' })
  })
  it('only the typed phrase overrides, and it is not a boolean', () => {
    const kill = vi.fn()
    stopMatching(rows, (r: { pid: number }) => r.pid === 1, { kill, allowProtected: 'yes' })
    expect(kill).not.toHaveBeenCalled()
    stopMatching(rows, (r: { pid: number }) => r.pid === 1, { kill, allowProtected: 'I asked the founder' })
    expect(kill).toHaveBeenCalledWith(1)
  })
})
