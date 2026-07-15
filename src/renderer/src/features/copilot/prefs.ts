// Whether the right-hand Voice AI panel is collapsed to its icon rail —
// remembered locally, same pattern as every other UI preference in the app.

const KEY_COLLAPSED = 'salesos.voiceai.collapsed'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* localStorage unavailable — just use the in-memory value this session */
  }
}

export function getVoiceAiCollapsed(): boolean {
  return read(KEY_COLLAPSED) === 'true'
}

export function setVoiceAiCollapsed(value: boolean): void {
  write(KEY_COLLAPSED, String(value))
}
