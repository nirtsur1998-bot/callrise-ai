// Pins node-webstorage-guard.ts in BOTH directions with fabricated inputs, so
// the check is proven able to fire without needing a real Node 26, and proven
// quiet in the two situations where firing would be a false alarm.
import { describe, expect, it } from 'vitest'
import { describeWebStorageShadow } from './setup/node-webstorage-guard'

describe('node-webstorage-guard', () => {
  it('fires on the exact shape measured on the Mac: DOM env, localStorage missing, sessionStorage present, Node 26', () => {
    const msg = describeWebStorageShadow({
      nodeVersion: '26.4.0',
      documentType: 'object',
      localStorageType: 'undefined',
      sessionStorageType: 'object'
    })
    expect(msg).not.toBeNull()
    // The message must carry the three things a stranded reader needs: what,
    // why, and the command that fixes it.
    expect(msg).toContain('Node 26.4.0')
    expect(msg).toContain('sessionStorage IS present')
    expect(msg).toContain('npx -y node@22')
    expect(msg).toContain('.nvmrc')
  })

  it('stays quiet in a plain node environment, where no document and no localStorage is CORRECT', () => {
    expect(
      describeWebStorageShadow({
        nodeVersion: '26.4.0',
        documentType: 'undefined',
        localStorageType: 'undefined',
        sessionStorageType: 'undefined'
      })
    ).toBeNull()
  })

  it('stays quiet in a DOM environment where localStorage is present (Node 22, the CI case)', () => {
    expect(
      describeWebStorageShadow({
        nodeVersion: '22.23.2',
        documentType: 'object',
        localStorageType: 'object',
        sessionStorageType: 'object'
      })
    ).toBeNull()
  })

  it('still fires without the sessionStorage tell, just without claiming it', () => {
    const msg = describeWebStorageShadow({
      nodeVersion: '27.0.0',
      documentType: 'object',
      localStorageType: 'undefined',
      sessionStorageType: 'undefined'
    })
    expect(msg).not.toBeNull()
    expect(msg).not.toContain('sessionStorage IS present')
  })
})
