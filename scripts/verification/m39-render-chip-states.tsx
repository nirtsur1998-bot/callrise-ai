/**
 * M39 Stage 2 — render the LIVE identity chip's every state to HTML, from the
 * component itself.
 *
 * WHY SSR AND NOT A HAND-WRITTEN FIXTURE. The point of a visual pass is to
 * catch what the code actually produces, and a fixture I type by hand is a
 * copy of what I BELIEVE it produces — it would agree with my reading of the
 * source even when the source is wrong, which is the one failure the screenshot
 * exists to catch. This calls the real component with real props and prints the
 * real markup; the companion CDP script injects that markup into the RUNNING
 * app so it is painted by the app's own compiled stylesheet, in the app's own
 * theme, at the app's own font size.
 *
 * WHAT IT THEREFORE DOES NOT PROVE, stated here so the screenshot is not read
 * as more than it is: that LiveView mounts this component, with these props, at
 * this point in the tree. That is a separate claim, covered by the wiring test
 * in __tests__/liveIdentityOffer.wiring.test.ts and by the typechecker — not by
 * the picture.
 *
 * usage: npx tsx --tsconfig tsconfig.web.json scripts/verification/m39-render-chip-states.tsx > states.json
 */
// tsx transpiles this file as classic JSX (React.createElement), not the
// automatic runtime the app's tsconfig selects — so React must be in scope by
// name here even though no app file needs it.
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiveIdentityOfferChip } from '../../src/renderer/src/features/live/LiveIdentityOfferChip'
import type { LiveIdentityOffer } from '../../src/renderer/src/features/live/liveIdentityOffer'

const c = (id: string, name: string): { id: string; name: string } => ({ id, name })

const STATES: { id: string; label: string; offer: LiveIdentityOffer; acceptedName?: string }[] = [
  {
    id: 'disagreement-link',
    label: 'linked to the wrong person, and we know who the right one is',
    offer: {
      kind: 'disagreement',
      spokenName: 'ZZ-M39 Harvey',
      disagreement: {
        spokenName: 'ZZ-M39 Harvey',
        linkedContact: c('kerry', 'ZZ-M39 Kerry'),
        suggestion: { kind: 'link', contact: c('harvey', 'ZZ-M39 Harvey') }
      }
    }
  },
  {
    id: 'disagreement-create',
    label: 'linked to the wrong person, and the right one is not a contact yet',
    offer: {
      kind: 'disagreement',
      spokenName: 'ZZ-M39 Anshur',
      disagreement: {
        spokenName: 'ZZ-M39 Anshur',
        linkedContact: c('damien', 'ZZ-M39 Damien Donehue'),
        suggestion: { kind: 'create' }
      }
    }
  },
  {
    id: 'disagreement-ambiguous',
    label: 'linked to the wrong person, and several contacts share the name',
    offer: {
      kind: 'disagreement',
      spokenName: 'ZZ-M39 Kevin',
      disagreement: {
        spokenName: 'ZZ-M39 Kevin',
        linkedContact: c('priya', 'ZZ-M39 Priya'),
        suggestion: {
          kind: 'ambiguous',
          candidates: [c('kevin-a', 'ZZ-M39 Kevin'), c('kevin-b', 'ZZ-M39 Kevin')]
        }
      }
    }
  },
  {
    id: 'unlinked-link',
    label: 'nothing linked, and the name matches one contact',
    offer: {
      kind: 'unlinked',
      spokenName: 'ZZ-M39 Harvey',
      suggestion: { kind: 'link', contact: c('harvey', 'ZZ-M39 Harvey') }
    }
  },
  {
    id: 'unlinked-create',
    label: 'nothing linked, and nobody by that name exists',
    offer: {
      kind: 'unlinked',
      spokenName: 'ZZ-M39 Anshur',
      suggestion: { kind: 'create' }
    }
  },
  {
    id: 'accepted',
    label: 'after the rep accepts — the deferred write, said out loud',
    acceptedName: 'ZZ-M39 Harvey',
    offer: {
      kind: 'disagreement',
      spokenName: 'ZZ-M39 Harvey',
      disagreement: {
        spokenName: 'ZZ-M39 Harvey',
        linkedContact: c('kerry', 'ZZ-M39 Kerry'),
        suggestion: { kind: 'link', contact: c('harvey', 'ZZ-M39 Harvey') }
      }
    }
  }
]

const out = STATES.map((s) => ({
  id: s.id,
  label: s.label,
  html: renderToStaticMarkup(
    <LiveIdentityOfferChip
      offer={s.offer}
      acceptedName={s.acceptedName ?? null}
      onLink={() => {}}
      onCreate={() => {}}
      onDismiss={() => {}}
    />
  )
}))

process.stdout.write(JSON.stringify(out, null, 2))
