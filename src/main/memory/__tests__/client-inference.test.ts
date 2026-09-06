// M36 Stage 3 — the unscoped-Rise gap. The default "New chat" conversation is
// bound to no client, so rag.ts never adds a client scope and every client:*
// memory is unreachable by construction: 8/14 (57%) on the retrieval harness
// against 13/14 (93%) when bound. Most unbound questions NAME the client — a
// company, a person — so the client can be inferred from the question and its
// scope added. This is the pure half: question + directory -> contact ids.
import { describe, expect, it } from 'vitest'
import { inferClientIds, buildClientDirectory } from '../client-inference'

const DIR = buildClientDirectory([
  { id: 'c-acme', name: 'Dana Levy', company: 'Acme Logistics' },
  { id: 'c-globex', name: 'Sam Okafor', company: 'Globex' },
  { id: 'c-noise', name: 'The Team', company: 'Solutions' }
])

describe('inferClientIds — which clients a question is about', () => {
  it('a company name in the question selects that client', () => {
    expect(inferClientIds('Who makes the buying decisions at Acme?', DIR)).toEqual(['c-acme'])
  })
  it("a contact's first name selects that client", () => {
    expect(inferClientIds('What did Dana say about their budget?', DIR)).toEqual(['c-acme'])
  })
  it('a pronoun-only question selects nobody (the scope-isolation control must stay unscoped)', () => {
    expect(inferClientIds('Do they need SOC 2 paperwork before signing?', DIR)).toEqual([])
  })
  it('matching is whole-word and case-insensitive; a substring is not a match', () => {
    expect(inferClientIds('is GLOBEX ready?', DIR)).toEqual(['c-globex'])
    expect(inferClientIds('the acmeified pipeline', DIR)).toEqual([])
  })
  it('two named clients in one question select both, in question order, once each', () => {
    expect(inferClientIds('Compare Globex with Acme, then Acme again', DIR)).toEqual(['c-globex', 'c-acme'])
  })
  it('generic words are never a client key, even when a contact is called that', () => {
    // "team" and "solutions" are too common to identify anyone
    expect(inferClientIds('what did the team say about solutions?', DIR)).toEqual([])
  })
  it('an empty directory or an empty question infers nothing', () => {
    expect(inferClientIds('Acme?', [])).toEqual([])
    expect(inferClientIds('', DIR)).toEqual([])
  })
})

describe('buildClientDirectory — the keys a contact can be recognised by', () => {
  it('uses the company and each name token of three letters or more, lower-cased', () => {
    const d = buildClientDirectory([{ id: 'x', name: 'Dana Levy', company: 'Acme Logistics' }])
    expect(d).toEqual([{ contactId: 'x', keys: ['acme logistics', 'acme', 'dana', 'levy'] }])
  })
  it('drops generic tokens so "The Team" at "Solutions" yields no keys at all', () => {
    expect(buildClientDirectory([{ id: 'n', name: 'The Team', company: 'Solutions' }])).toEqual([{ contactId: 'n', keys: [] }])
  })
})
