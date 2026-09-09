// positive control for the BUG-141 instrument: a module that is SLOW TO
// EVALUATE, so a test importing it is genuinely stalled inside module
// resolution when the watchdog fires.
await new Promise((r) => setTimeout(r, 5000))
export const ready = true
