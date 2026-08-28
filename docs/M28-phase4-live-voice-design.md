# M28 Phase 4 — live voice mode: design pass (NO code yet, per the brief)

Written 2026-08-21, research verified against current provider docs (not
memory). This is the design the founder reviews before any Phase 4 code.

## The two architectures (capability-gated by the user's own keys)

### A. Native speech-to-speech — OpenAI Realtime over WebRTC (the quality path)

Verified current shape (2026): the renderer connects to OpenAI as a WebRTC
peer; authentication uses a short-lived **ephemeral client secret** minted by
a backend via `POST /v1/realtime/client_secrets` (note: 2026 endpoint — older
tutorials that POST to `/realtime/sessions` no longer connect; SDP is
exchanged at `/v1/realtime/calls`). Ephemeral tokens carry a fixed ~2h TTL.

**Our trust model makes this clean:** in CallRise the "backend" is the
Electron MAIN PROCESS, and the API key is the user's own, stored locally in
safeStorage. Main mints the ephemeral secret with the user's key and hands
ONLY the ephemeral secret to the renderer — the raw key never crosses the
IPC boundary, matching the existing rule that keys live in main. No server
of ours is involved, ever.

- New module `src/main/assistant/realtime-token.ts`: mint + refresh; returns
  `{clientSecret, expiresAt}`. Renderer `useRealtimeVoice` owns the
  RTCPeerConnection + mic track + remote audio element.
- Function calling: the Realtime session supports tools — we register the
  SAME dispatch lookups (search calls / contact / deal / schedule) as
  Realtime function definitions; the model's function calls round-trip over
  the data channel to main (execute locally, return JSON). Context assembly
  must fit the session format: profiles + retrieval injected as session
  instructions at session start, refreshed per reconnect.
- **Gemini Live is the second native option — verified viable**: WebSocket
  transport, ephemeral tokens (v1beta endpoint, `access_token` query param),
  function calling supported. Same main-mints-token shape. Recommend
  shipping OpenAI first, Gemini Live behind the same abstraction second.

### B. Chained fallback (any-provider path)

Deepgram streaming STT (an `utterance mode` session — see isolation below)
→ the user's chain via `streamWithFallback` (purpose `assistant-chat`) → TTS
via any TTS-capable key. Latency is seconds, not sub-second; it exists so
voice works for users with no realtime-capable key.

### Honest degradation ladder (each step shows its reason)

1. Realtime-capable key (OpenAI; later Gemini) → native speech-to-speech.
2. Else Deepgram + any chat model + TTS key → chained voice.
3. Else Deepgram + chat model, no TTS → voice in, text out.
4. Else → text only; the voice button explains exactly which key unlocks it.

## Capability catalog additions

- `supportsRealtimeVoice` — provider-level (openai now, google when built).
- `supportsTTS` — provider-level (openai `/v1/audio/speech`; gemini TTS).
- Realtime does NOT fit the `AIProvider` text abstraction (by that layer's
  own design) — these flags gate NEW modules, they don't extend
  `complete()/stream()`. Adding the flags touches the catalog + a new
  capability check, not `resolveChain`'s tool filter.

## The five design questions the brief requires answered

1. **Echo cancellation** (the #1 documented production failure — the agent
   hearing itself): `getUserMedia({audio: {echoCancellation: true,
   noiseSuppression: true, autoGainControl: true}})` is MANDATORY on this
   surface (unlike the live-call path, which captures raw deliberately).
   For WebRTC (path A) the browser's AEC is tuned for exactly this loop.
   For path B, TTS playback pauses STT ingestion (half-duplex) unless AEC
   is confirmed working — barge-in via explicit tap-to-interrupt first,
   full-duplex later if measured safe. Also: if the CallRise virtual mic is
   the selected input device, warn — AEC cannot cancel against a virtual
   loopback device.
2. **Barge-in**: path A gets it natively (server VAD + response cancel on
   user speech). Path B v1: tap-to-interrupt (stop TTS playback + cancel the
   stream via the existing real Stop); acoustic barge-in only when AEC is
   proven on real hardware.
3. **Tools mid-voice**: path A via Realtime function calling (above). Path B
   reuses the turn dispatcher unchanged (it's just a text turn with audio
   I/O bolted on).
4. **Pipeline isolation — what must NOT be shared**: nothing from
   `recorder.ts`/`transcription.ts`'s call machinery. A Rise voice session
   must never open a CallJournal, flip `hasLiveCall()`, feed the cue
   engines, or touch consent (mic-only, own voice, deliberate action —
   same analysis as Phase 3, stated not assumed). Concretely: path A never
   touches Deepgram at all; path B needs the `mode:'utterance'` (or
   extracted `DeepgramStream`) refactor flagged in the Phase 0 map, built
   so the live-call path's behavior is provably unchanged (its existing
   tests must not change). Rule inherited from the brief: if Rise voice is
   open when a real call starts, Rise voice yields the mic — the live call
   always wins.
5. **Cost visibility**: realtime audio is priced per-minute on the USER's
   key. The voice UI shows elapsed session time persistently while
   connected, plus a "this uses your OpenAI key, billed per minute" line at
   session start. No dressed-up estimates — time connected is the honest
   number we actually have.

## Memory

Voice conversations transcribe into the SAME conversation log (path A
provides transcripts of both sides; path B has them by construction) and
feed Phase 2 extraction identically — same fresh-read permission gates, same
per-conversation "don't learn from this" toggle, same `assistant:<id>`
evidence convention. Nothing new to invent; the Phase 2 funnel already
handles it.

## Suggested build order (after founder sign-off)

1. Capability flags + degradation-ladder plumbing (test-heavy, no audio).
2. Path B chained voice (extends Phase 3's pieces; every provider benefits).
3. Path A OpenAI Realtime (token mint in main + renderer WebRTC session).
4. Gemini Live behind the same abstraction.
5. Real-hardware echo/barge-in verification on THIS machine before any of
   it defaults on — the four audio properties from the milestone brief apply
   to every step.

Sources: [OpenAI Realtime WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) · [webrtcHacks Realtime API guide](https://webrtchacks.com/the-unofficial-guide-to-openai-realtime-webrtc-api/) · [Realtime WebRTC endpoints (2026 changes)](https://docs.litellm.ai/blog/realtime_webrtc_http_endpoints) · [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api) · [Gemini Live WebSockets](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) · [Gemini Live ephemeral tokens example](https://github.com/google-gemini/gemini-live-api-examples/tree/main/gemini-live-ephemeral-tokens-websocket)
