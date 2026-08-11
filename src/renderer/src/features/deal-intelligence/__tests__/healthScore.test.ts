import { describe, expect, it } from 'vitest'
import { computeTrajectory, sanitizeHealthScoreResponse, type HealthFactors } from '../healthScore'

const validFactors = (overrides: Partial<HealthFactors> = {}): HealthFactors => ({
  engagement: 70,
  sentiment: 65,
  objectionStatus: 80,
  momentum: 60,
  agendaCoverage: 75,
  ...overrides
})

// A well-formed raw tool-call response, the shape sanitizeHealthScoreResponse expects
// before it has been validated. Typed as Record<string, unknown> (matching the
// function's own `value: unknown` param) so malformed-shape tests below can override
// individual fields with the wrong type without fighting the compiler.
const response = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  score: 72,
  topRecommendation: 'Confirm the budget owner before the next call.',
  factors: validFactors(),
  ...overrides
})

// Returns a copy of a response with the given key entirely absent (not just
// undefined) — used to simulate a field the model left out of the tool call.
const omit = (obj: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...obj }
  delete copy[key]
  return copy
}

describe('computeTrajectory — no prior score', () => {
  it("returns 'flat' when previous is null, since there is nothing to compare against", () => {
    expect(computeTrajectory(90, null)).toBe('flat')
    expect(computeTrajectory(0, null)).toBe('flat')
  })
})

describe('computeTrajectory — deadband', () => {
  // TRAJECTORY_DEADBAND is 4 in healthScore.ts (read from source; it isn't exported,
  // so it can't be imported directly).
  it('returns flat when the delta is within the deadband on either side', () => {
    expect(computeTrajectory(52, 50)).toBe('flat') // +2
    expect(computeTrajectory(48, 50)).toBe('flat') // -2
    expect(computeTrajectory(50, 50)).toBe('flat') // 0
  })

  it('treats the exact deadband boundary as flat, not crossed (comparison is strict > / <, not >=/<=)', () => {
    expect(computeTrajectory(54, 50)).toBe('flat') // delta === 4
    expect(computeTrajectory(46, 50)).toBe('flat') // delta === -4
  })

  it('returns up once the delta is clearly above the deadband', () => {
    expect(computeTrajectory(55, 50)).toBe('up') // delta === 5
  })

  it('returns down once the delta is clearly below the deadband', () => {
    expect(computeTrajectory(45, 50)).toBe('down') // delta === -5
  })
})

describe('sanitizeHealthScoreResponse — happy path', () => {
  it('builds a correct DealHealthScore, computing trajectory against previousScore', () => {
    const result = sanitizeHealthScoreResponse(response({ score: 72 }), 1_700_000_000_000, 50)
    // delta = 72 - 50 = 22, clearly above the deadband -> 'up'
    expect(result).toEqual({
      score: 72,
      trajectory: 'up',
      factors: {
        engagement: 70,
        sentiment: 65,
        objectionStatus: 80,
        momentum: 60,
        agendaCoverage: 75
      },
      topRecommendation: 'Confirm the budget owner before the next call.',
      computedAtMs: 1_700_000_000_000
    })
  })

  it('passes computedAtMs through unchanged, even when it is 0 (a falsy value)', () => {
    // Adversarial: 0 is falsy, so this would break silently if the implementation
    // ever grew a `computedAtMs || Date.now()`-style fallback.
    const result = sanitizeHealthScoreResponse(response(), 0, null)
    expect(result?.computedAtMs).toBe(0)
  })

  it('rounds fractional score and factor values to integers rather than leaving them fractional', () => {
    const result = sanitizeHealthScoreResponse(
      response({
        score: 87.6,
        factors: validFactors({ engagement: 72.4, sentiment: 65.5 })
      }),
      0,
      null
    )
    expect(result?.score).toBe(88)
    expect(Number.isInteger(result?.score)).toBe(true)
    expect(result?.factors.engagement).toBe(72)
    expect(result?.factors.sentiment).toBe(66)
  })

  it('trims surrounding whitespace from topRecommendation', () => {
    const result = sanitizeHealthScoreResponse(
      response({ topRecommendation: '   Watch the champion get looped in.   ' }),
      0,
      null
    )
    expect(result?.topRecommendation).toBe('Watch the champion get looped in.')
  })

  it('truncates an overlong topRecommendation to 300 characters', () => {
    const long = 'a'.repeat(310)
    const result = sanitizeHealthScoreResponse(response({ topRecommendation: long }), 0, null)
    expect(result?.topRecommendation).toHaveLength(300)
    expect(result?.topRecommendation).toBe('a'.repeat(300))
  })
})

describe('sanitizeHealthScoreResponse — invalid score', () => {
  it('returns null when score is missing', () => {
    expect(sanitizeHealthScoreResponse(omit(response(), 'score'), 0, null)).toBeNull()
  })

  it('returns null when score is a non-numeric string', () => {
    expect(sanitizeHealthScoreResponse(response({ score: '85' }), 0, null)).toBeNull()
  })

  it('returns null when score is NaN', () => {
    // typeof NaN === 'number', so this only gets caught by the Number.isFinite check.
    expect(sanitizeHealthScoreResponse(response({ score: Number.NaN }), 0, null)).toBeNull()
  })

  it('returns null when score is Infinity', () => {
    expect(
      sanitizeHealthScoreResponse(response({ score: Number.POSITIVE_INFINITY }), 0, null)
    ).toBeNull()
  })
})

describe('sanitizeHealthScoreResponse — invalid topRecommendation', () => {
  it('returns null when topRecommendation is missing', () => {
    expect(sanitizeHealthScoreResponse(omit(response(), 'topRecommendation'), 0, null)).toBeNull()
  })

  it('returns null when topRecommendation is an empty string', () => {
    expect(sanitizeHealthScoreResponse(response({ topRecommendation: '' }), 0, null)).toBeNull()
  })

  it('returns null when topRecommendation is whitespace-only (trims down to empty)', () => {
    expect(sanitizeHealthScoreResponse(response({ topRecommendation: '   ' }), 0, null)).toBeNull()
  })
})

describe('sanitizeHealthScoreResponse — factor sanitization', () => {
  it('clamps or defaults every out-of-range or malformed factor field independently', () => {
    const result = sanitizeHealthScoreResponse(
      response({
        factors: {
          engagement: -50, // negative -> clamps to 0
          sentiment: 150, // over 100 -> clamps to 100
          objectionStatus: 'high', // non-numeric -> defaults to 0
          agendaCoverage: Number.NaN // finite check fails -> defaults to 0
          // momentum intentionally omitted -> defaults to 0
        }
      }),
      0,
      null
    )
    expect(result?.factors).toEqual({
      engagement: 0,
      sentiment: 100,
      objectionStatus: 0,
      momentum: 0,
      agendaCoverage: 0
    })
  })

  it('defaults every factor to 0 when the factors object is missing entirely', () => {
    const result = sanitizeHealthScoreResponse(
      { score: 72, topRecommendation: 'Follow up tomorrow.' },
      0,
      null
    )
    expect(result?.factors).toEqual({
      engagement: 0,
      sentiment: 0,
      objectionStatus: 0,
      momentum: 0,
      agendaCoverage: 0
    })
  })

  it('defaults every factor to 0 when factors is null', () => {
    const result = sanitizeHealthScoreResponse(response({ factors: null }), 0, null)
    expect(result?.factors).toEqual({
      engagement: 0,
      sentiment: 0,
      objectionStatus: 0,
      momentum: 0,
      agendaCoverage: 0
    })
  })

  it('defaults every factor to 0 when factors is not an object (e.g. a string)', () => {
    const result = sanitizeHealthScoreResponse(response({ factors: 'oops' }), 0, null)
    expect(result?.factors).toEqual({
      engagement: 0,
      sentiment: 0,
      objectionStatus: 0,
      momentum: 0,
      agendaCoverage: 0
    })
  })
})

describe('sanitizeHealthScoreResponse — adversarial edge cases', () => {
  it('returns null when value is null', () => {
    expect(sanitizeHealthScoreResponse(null, 0, null)).toBeNull()
  })

  it('returns null when value is undefined', () => {
    expect(sanitizeHealthScoreResponse(undefined, 0, null)).toBeNull()
  })

  it('returns null when value is a primitive (string or number), not an object', () => {
    expect(sanitizeHealthScoreResponse('not an object', 0, null)).toBeNull()
    expect(sanitizeHealthScoreResponse(42, 0, null)).toBeNull()
  })

  it('returns null when value is an array (passes the typeof object check but has no score)', () => {
    // Arrays are typeof 'object' in JS, so this exercises a path the `!value ||
    // typeof value !== 'object'` guard alone does not reject.
    expect(sanitizeHealthScoreResponse([1, 2, 3], 0, null)).toBeNull()
  })

  it('does not crash and still sanitizes correctly when previousScore itself is an unusual number', () => {
    // previousScore is caller-supplied and typed number | null, not re-validated here;
    // confirm a non-finite previous score degrades to 'flat' rather than throwing.
    const result = sanitizeHealthScoreResponse(response({ score: 60 }), 0, Number.NaN)
    expect(result?.trajectory).toBe('flat')
  })
})
