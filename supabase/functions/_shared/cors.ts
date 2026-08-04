// Shared response helpers for edge functions in this project. Deno-native
// (no npm dependency) — every function here runs on Supabase's Deno runtime.

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

export function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}
