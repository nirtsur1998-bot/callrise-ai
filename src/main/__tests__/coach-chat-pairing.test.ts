// BUG-109 — the user/assistant pairing invariant, enforced instead of assumed.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOnUserTurn } from '../coach-chat-history'
import { appendCoachChatTurn, getCall, saveCall } from '../calls-fs'

describe('startOnUserTurn — the model never sees a history that opens on the assistant', () => {
  const u = (t: string) => ({ role: 'user' as const, text: t })
  const a = (t: string) => ({ role: 'assistant' as const, text: t })

  it('leaves a well-formed history alone', () => {
    const h = [u('1'), a('2'), u('3'), a('4')]
    expect(startOnUserTurn(h)).toEqual(h)
  })

  it('drops a leading assistant turn — the shape an odd slice produces', () => {
    const h = [a('0'), u('1'), a('2')]
    expect(startOnUserTurn(h)).toEqual([u('1'), a('2')])
  })

  it('the exact BUG-109 shape: slice(-N) with N odd lands on an assistant turn', () => {
    const h: { role: 'user' | 'assistant'; text: string }[] = []
    for (let i = 0; i < 10; i++) h.push(u(`u${i}`), a(`a${i}`))
    const sliced = h.slice(-5) // a7 u8 a8 u9 a9
    expect(sliced[0].role).toBe('assistant')
    expect(startOnUserTurn(sliced)[0]).toEqual(u('u8'))
  })

  it('a history with no user turn at all becomes empty rather than a lone assistant', () => {
    expect(startOnUserTurn([a('x')])).toEqual([])
    expect(startOnUserTurn([])).toEqual([])
  })
})

describe('appendCoachChatTurn — a pair shares one mode', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coach-pair-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a caller that passes two modes gets a pair with the USER turn\'s mode on both, and the file agrees', async () => {
    const call = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      segments: [{ speaker: 0, text: 'hello' }]
    })
    const res = await appendCoachChatTurn(
      dir,
      call.id,
      { text: 'q', mode: 'practice' },
      { text: 'a', mode: 'advisor' }
    )
    expect(res).toBeTruthy()
    const saved = (await getCall(dir, call.id))!.coachChat!
    expect(saved.map((m) => m.mode)).toEqual(['practice', 'practice'])
    const raw = JSON.parse(readFileSync(join(dir, `${call.id}.json`), 'utf8'))
    expect(raw.coachChat.map((m: { mode: string }) => m.mode)).toEqual(['practice', 'practice'])
  })

  it('a well-formed pair is stored exactly as given', async () => {
    const call = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      segments: [{ speaker: 0, text: 'hello' }]
    })
    await appendCoachChatTurn(dir, call.id, { text: 'q', mode: 'advisor' }, { text: 'a', mode: 'advisor' })
    const saved = (await getCall(dir, call.id))!.coachChat!
    expect(saved.map((m) => [m.role, m.mode])).toEqual([
      ['user', 'advisor'],
      ['assistant', 'advisor']
    ])
  })
})
