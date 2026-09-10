// Diagnostic: dump the control call's detail page so the drive's negative
// result can be explained rather than assumed.
import { connect } from './cdp.mjs'

const cdp = await connect(Number(process.argv[2] || 9347))
const text = String(await cdp.evaluate('document.body.innerText'))
console.log('--- full detail page text ---')
console.log(text)
console.log('')
console.log('--- what the API returns for this call ---')
console.log(
  String(
    await cdp.evaluate(
      `(async () => {
        const c = await window.api.calls.get('zz-m39-realname')
        return JSON.stringify({
          segments: c && c.segments && c.segments.length,
          identities: c && c.speakerIdentities,
          consent: c && c.consent
        })
      })()`
    )
  )
)
process.exit(0)
