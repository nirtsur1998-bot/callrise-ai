// Is an app answering on this debug port, and what is it showing?
// usage: node scripts/verification/m39-probe-alive.mjs [port]
import { connect } from './cdp.mjs'
const port = Number(process.argv[2] || 9347)
try {
  const c = await connect(port)
  console.log('CONNECTED:', String(await c.evaluate('location.hash + " | " + document.title')))
} catch (e) {
  console.log(`NO APP ON ${port}:`, e.message)
  process.exit(1)
}
// The open WebSocket keeps node's event loop alive; without this the script
// prints its answer and then hangs, which reads as "the app is unreachable".
process.exit(0)
