// Plain JS worker_threads body for thread-independence.test.ts (§1.4,
// acceptance criterion 3). Deliberately not TypeScript: worker_threads spawns
// this file directly via Node, with no bundler/loader in between, the same
// reason pcm-processor.js is plain JS rather than compiled from a .ts source.
/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS worker_threads body, loaded by Node directly, not part of the TS app bundle */
const { parentPort } = require('worker_threads')

const ticks = []
let timer = null

parentPort.on('message', (msg) => {
  if (msg.type === 'start') {
    timer = setInterval(() => ticks.push(Date.now()), msg.intervalMs)
  } else if (msg.type === 'stop') {
    clearInterval(timer)
    parentPort.postMessage({ type: 'ticks', ticks })
  }
})
