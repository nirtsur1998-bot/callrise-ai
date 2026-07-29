import { describe, expect, it } from 'vitest'
import { classifyOutputLabel } from '../headphones'

describe('classifyOutputLabel', () => {
  it('recognizes common headphone labels', () => {
    expect(classifyOutputLabel('Headphones (Realtek High Definition Audio)')).toBe('headphones')
    expect(classifyOutputLabel('WH-1000XM4 Headset')).toBe('headphones')
    expect(classifyOutputLabel('AirPods Pro')).toBe('headphones')
    expect(classifyOutputLabel('Galaxy Buds2')).toBe('headphones')
    expect(classifyOutputLabel('Jabra Earbuds')).toBe('headphones')
  })

  it('recognizes common speaker labels', () => {
    expect(classifyOutputLabel('Speakers (Realtek High Definition Audio)')).toBe('speakers')
    expect(classifyOutputLabel('Built-in Output')).toBe('speakers')
    expect(classifyOutputLabel('Internal Speakers')).toBe('speakers')
    expect(classifyOutputLabel('Default')).toBe('speakers')
  })

  it('prefers the headphone match when a label could plausibly match both', () => {
    expect(classifyOutputLabel('Bluetooth Headphones (Speaker Mode)')).toBe('headphones')
  })

  it('returns unknown for an empty or unrecognized label', () => {
    expect(classifyOutputLabel('')).toBe('unknown')
    expect(classifyOutputLabel('   ')).toBe('unknown')
    expect(classifyOutputLabel('USB Audio Device 47B2')).toBe('unknown')
  })

  it('is case-insensitive', () => {
    expect(classifyOutputLabel('HEADPHONES')).toBe('headphones')
    expect(classifyOutputLabel('speakers')).toBe('speakers')
  })
})
