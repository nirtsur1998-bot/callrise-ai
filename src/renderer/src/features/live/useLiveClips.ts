import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallSegment } from '@renderer/features/calls/types'

const CONFIRM_MS = 1500 // how long the inline "Clipped" confirmation stays up
const SNIPPET_TURNS = 2 // "the last ~1-2 turns" per the clip button's spec
const SNIPPET_MAX_CHARS = 300 // keep the saved bookmark text skimmable

interface PendingClip {
  atMs: number
  text: string
}

export interface UseLiveClips {
  /** True for ~1.5s right after a successful capture — drives the inline
   *  "Clipped" confirmation next to the button. */
  justClipped: boolean
  /** Capture the current moment: an elapsed-ms timestamp (caller supplies it,
   *  since a live-in-progress call has no callId/playback clock yet) plus a
   *  short recent-transcript snippet built from what's already on screen.
   *  Purely in-memory — nothing is saved until flush() runs. */
  captureClip: (elapsedMs: number, segments: CallSegment[], interimText: string) => void
  /** Send every clip captured this call to the now-saved call as bookmarks
   *  (window.api.calls.addBookmark), then clear the buffer. Fire-and-forget:
   *  a bookmark failing here must never affect the call save that already
   *  succeeded. */
  flush: (callId: string) => void
  /** Clear the buffer without saving — e.g. a fresh call starting, so clips
   *  from an abandoned/previous session can't leak onto the next save. */
  reset: () => void
}

/**
 * In-memory clip buffer for the Live Calls "Clip this" button. The backend
 * bookmark API (window.api.calls.addBookmark) requires a callId, but a
 * live-in-progress call doesn't get one until it's saved at the end — so
 * clips are held here locally during the call and flushed to real bookmarks
 * once useTranscription's save resolves with a callId (see LiveView's
 * handleSaved, which wraps the onSaved prop passed into useTranscription).
 */
export function useLiveClips(): UseLiveClips {
  const clipsRef = useRef<PendingClip[]>([])
  const [justClipped, setJustClipped] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const captureClip = useCallback(
    (elapsedMs: number, segments: CallSegment[], interimText: string): void => {
      const recent = segments
        .slice(-SNIPPET_TURNS)
        .map((s) => s.text.trim())
        .filter(Boolean)
      if (interimText.trim()) recent.push(interimText.trim())
      const text = recent.join(' ').slice(0, SNIPPET_MAX_CHARS)
      if (!text) return // nothing said yet — nothing to clip

      clipsRef.current.push({ atMs: Math.max(0, Math.round(elapsedMs)), text })

      setJustClipped(true)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setJustClipped(false), CONFIRM_MS)
    },
    []
  )

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  const flush = useCallback((callId: string): void => {
    const pending = clipsRef.current
    clipsRef.current = []
    for (const clip of pending) {
      void window.api.calls.addBookmark(callId, clip.atMs, clip.text).catch(() => {
        /* non-fatal: the call itself already saved fine */
      })
    }
  }, [])

  const reset = useCallback((): void => {
    clipsRef.current = []
  }, [])

  return { justClipped, captureClip, flush, reset }
}
