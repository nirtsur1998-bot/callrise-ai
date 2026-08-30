import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * M31 Stage 5 — the motion vocabulary, and the one rule in it that is a
 * CONSTRAINT rather than a preference.
 *
 * The founder's brief contained two clauses that pull against each other:
 * "spring-physics micro-interactions" and "nothing bouncy". A real spring
 * overshoots — that is what makes it a spring — so the second clause is the
 * one that decides the curves, and `--ease-settle` decelerates hard without
 * ever crossing its target.
 *
 * "Nothing bouncy" is usually a taste note that survives exactly as long as
 * whoever heard it. It does not have to be: a cubic-bezier overshoots if and
 * only if one of its control points has a y outside [0, 1]. That is a
 * property of four numbers, so it can be checked, and the check below is what
 * stops a future "let's make it feel more alive" from quietly reintroducing
 * the bounce the founder ruled out.
 */

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf8')

/**
 * Strip CSS comments before any assertion about CODE.
 *
 * Not optional, and this file proved it on its own first run: the press
 * rule's comment explains why it uses `scale:` and NOT `transform: scale()`,
 * and the assertion forbidding `transform: scale` failed — on the comment
 * saying so. The same trap latencyPolicy.test.ts records, arriving from the
 * other direction: there a comment made a check pass for the wrong reason,
 * here one made it fail for the wrong reason. Both are the check reading
 * prose and reporting on code.
 */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The `@theme` block — motion tokens live with the palette, not in a
 *  component, so there is exactly one place to change the app's feel. */
const THEME = CSS.slice(CSS.indexOf('@theme {'), CSS.indexOf('@layer base'))

function tokenValue(name: string): string {
  const m = THEME.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!m) throw new Error(`motion token ${name} is not defined in @theme`)
  return m[1].trim()
}

describe('the motion vocabulary exists', () => {
  it('defines three durations and three curves — no more', () => {
    for (const d of ['--motion-press', '--motion-quick', '--motion-base']) {
      expect(tokenValue(d)).toMatch(/^\d+ms$/)
    }
    for (const e of ['--ease-entrance', '--ease-exit', '--ease-settle']) {
      expect(tokenValue(e)).toMatch(/^cubic-bezier\(/)
    }
    // A vocabulary nobody can hold in their head gets extended instead of
    // used. If a fourth is genuinely needed, deleting this line should be a
    // deliberate act, not a side effect.
    const durations = [...THEME.matchAll(/--motion-(?!press-scale)[a-z-]+:/g)]
    const eases = [...THEME.matchAll(/--ease-[a-z-]+:/g)]
    expect(durations.length, 'a fourth duration was added').toBe(3)
    expect(eases.length, 'a fourth easing was added').toBe(3)
  })

  it('the press scale is subtle enough to feel rather than watch', () => {
    const scale = Number(tokenValue('--motion-press-scale'))
    expect(scale).toBeGreaterThan(0.97)
    expect(scale).toBeLessThan(1)
  })
})

describe('NOTHING BOUNCY — enforced, not just asked for', () => {
  const easings = [...THEME.matchAll(/(--ease-[a-z-]+):\s*cubic-bezier\(([^)]+)\)/g)]

  it('finds every easing token to check', () => {
    expect(easings.length).toBe(3)
  })

  it.each(easings.map((m) => [m[1], m[2]]))('%s does not overshoot', (name, args) => {
    const [x1, y1, x2, y2] = args.split(',').map((n) => Number(n.trim()))
    expect([x1, y1, x2, y2].every(Number.isFinite), `${name} has unparseable control points`).toBe(
      true
    )
    // x must stay in [0,1] for a valid CSS timing function at all.
    expect(x1, `${name}: x1 out of range`).toBeGreaterThanOrEqual(0)
    expect(x1, `${name}: x1 out of range`).toBeLessThanOrEqual(1)
    expect(x2, `${name}: x2 out of range`).toBeGreaterThanOrEqual(0)
    expect(x2, `${name}: x2 out of range`).toBeLessThanOrEqual(1)
    // y OUTSIDE [0,1] is exactly what makes a curve overshoot its target and
    // spring back. That is the bounce the founder ruled out.
    for (const [label, y] of [
      ['y1', y1],
      ['y2', y2]
    ] as const) {
      expect(y, `${name}: ${label}=${y} overshoots — this is the bounce`).toBeGreaterThanOrEqual(0)
      expect(y, `${name}: ${label}=${y} overshoots — this is the bounce`).toBeLessThanOrEqual(1)
    }
  })
})

describe('the vocabulary is actually wired up', () => {
  it("Tailwind's own transition default points at the tokens", () => {
    // ~160 `transition` utilities across the renderer. If these two do not
    // reference the tokens, the app has a motion vocabulary that almost
    // nothing speaks, which is worse than none — it reads as done.
    expect(tokenValue('--default-transition-duration')).toContain('--motion-quick')
    expect(tokenValue('--default-transition-timing-function')).toContain('--ease-settle')
  })

  /** The press rule as CODE — comments removed, so prose about the rule can
   *  neither satisfy nor break an assertion about it.
   *
   *  Strip FIRST, then locate. The first attempt sliced on comment text
   *  (`── PRESS`) and stripped afterwards, which cannot work: the slice began
   *  in the middle of a comment, so it carried no opening delimiter for the
   *  stripper to match, and the whole rationale paragraph — including the
   *  words "transform: scale()" explaining why it is NOT used — survived into
   *  the assertion. Anchor on the CSS, never on the prose about it. */
  const pressRule = (() => {
    const base = stripCssComments(
      CSS.slice(CSS.indexOf('@layer base'), CSS.indexOf('@layer utilities'))
    )
    const start = base.indexOf(':where(button')
    expect(start, 'no press rule found in @layer base').toBeGreaterThan(-1)
    const end = base.indexOf(':focus-visible', start)
    return base.slice(start, end > start ? end : start + 800)
  })()

  it('the press rule uses the standalone scale property, not transform', () => {
    // Tailwind v4 emits translate-*/rotate-* as their own properties, so a
    // transform here would clobber every control positioned with
    // -translate-y-1/2 — including the icon button inside every key input.
    expect(pressRule).toMatch(/\n\s*scale: var\(--motion-press-scale\);/)
    expect(pressRule, 'transform would clobber Tailwind v4 translate/rotate').not.toMatch(
      /transform:\s*scale/
    )
  })

  it('press is applied by element, not opted into per component', () => {
    // The founder asked for "every interactive element, consistently". A
    // utility class each component must remember to add is not that.
    for (const sel of ['button', "[role='button']", "[role='switch']"]) {
      expect(pressRule, `${sel} does not get a press`).toContain(sel)
    }
    // and never on a disabled control, which would imply it did something
    expect(pressRule).toContain(':disabled')
  })
})

describe('the Stop control is not the quietest button on screen', () => {
  // Stage 5 item 3. Verified here rather than by screenshot for two reasons:
  // the state only exists mid-stream, and photographing it would spend the
  // founder's Hugging Face credit — which the card next to it warns is about
  // ten cents a month. A source assertion costs nothing and checks the thing
  // that would actually regress: the variant on the button.
  const BUTTON = readFileSync(join(__dirname, '..', 'components', 'Button.tsx'), 'utf8')
  const RISE = readFileSync(
    join(__dirname, '..', 'features', 'assistant', 'AssistantView.tsx'),
    'utf8'
  )

  it("Rise's Stop uses the stop variant, not secondary", () => {
    const stopButton = RISE.slice(RISE.indexOf('chat.stop()') - 260, RISE.indexOf('chat.stop()'))
    expect(stopButton, 'Stop is back to the app\'s quietest treatment').not.toContain(
      'variant="secondary"'
    )
    expect(stopButton).toContain('variant="stop"')
  })

  it('the stop variant is high-contrast and carries no status colour', () => {
    const variants = BUTTON.slice(BUTTON.indexOf('const VARIANT'), BUTTON.indexOf('const SIZE'))
    const stop = variants.slice(variants.indexOf('stop:'))
    // Inverted ink-on-canvas: the loudest thing the palette can say without
    // claiming a meaning.
    expect(stop).toContain('bg-ink')
    expect(stop).toContain('text-canvas')
    // Explicitly NOT danger. Stopping a stream destroys nothing and is
    // undoable by pressing Send again; painting it red would teach that red
    // sometimes means "safe, go ahead", which cheapens every real warning.
    expect(stop, 'stop must not borrow the destructive colour').not.toMatch(/danger|red/)
  })
})

describe('the reduced-motion claim matches the code', () => {
  it('the shimmer fallback does not promise an animation the blanket rule kills', () => {
    // It used to specify `animation: pulse 1.6s infinite`, which never ran:
    // the blanket rule at the bottom of the file sets animation-duration to
    // 0.001ms !important on everything. The code described a behaviour the
    // app has never had.
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    const shimmerFallback = reduced.slice(
      reduced.indexOf('.animate-shimmer'),
      reduced.indexOf('.animate-shimmer') + 400
    )
    expect(shimmerFallback).toContain('animation: none')
    expect(shimmerFallback, 'a pulse here would be a claim the blanket rule overrides').not.toMatch(
      /animation:\s*pulse/
    )
  })

  it('still blankets every animation for reduced-motion users', () => {
    // The guard on the guard: deleting the fallback must not have weakened
    // the rule that made it redundant.
    expect(CSS).toMatch(/animation-duration:\s*0\.001ms\s*!important/)
    expect(CSS).toMatch(/transition-duration:\s*0\.001ms\s*!important/)
  })
})
