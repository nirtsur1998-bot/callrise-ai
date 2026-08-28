// M28 — the ONE place the assistant section's display name lives. Founder
// rule: renaming the section (Rise / Wingman / War Room / ...) must be a
// one-line change, so nothing else in the app may hardcode this string —
// nav label, Settings cards, empty states, prompts: all import from here.
// Internal identifiers (nav id 'assistant', purpose 'assistant-chat', IPC
// channel names, file paths) deliberately use the neutral word 'assistant'
// so a rename never touches code identity, only this constant.
export const ASSISTANT_SECTION_NAME = 'Rise'

/** The NavId this section mounts under — must match the entry added to
 *  nav-items.ts's NavId union. Exported so deep-link callers never hardcode
 *  the string. */
export const ASSISTANT_NAV_ID = 'assistant' as const
