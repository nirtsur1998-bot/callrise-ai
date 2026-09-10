// BUG-199 — the compile-time egress guard covered CALLS only.
//
// `CALL_FIELD_RULES` (`calls-fs.ts`) is typed `{ [K in keyof Required<Call>]:
// … }`, so a field added to a call record without being classified is a
// COMPILE ERROR rather than a silent leak. Its own comment names why it
// exists: *"the fix for the shape that produced BUG-014, BUG-028 and
// BUG-115: three separate discoveries that an allowlist had fallen behind a
// growing type."*
//
// Contacts and deals had no such guard. `backup.ts` pushed `payload: c` — the
// whole record — so any field added to `Contact` or `Deal` reached the user's
// cloud backup on the next sync with nothing having classified it. Not
// hypothetical: the CRM work would add an identifier to `Contact`, and it
// would egress the moment it was written.
//
// THIS MODULE CHANGES NOTHING THAT LEAVES THE DEVICE TODAY. Every field
// currently on both records is user-entered CRM data the backup exists to
// carry, and all of them stay SYNCED. It is a missing guard being added, not
// an escaping field being caught — which is exactly when it is cheap.
//
// It lives in its own file rather than in either record's module because both
// need it, and duplicating a one-line rule with a "keep in sync" comment is
// the shape [[BUG-123]] is about.

/** May this field leave the device in the backup payload? */
export type FieldEgress =
  /** Travels in the backup payload. The user's own CRM data, under the
   *  `contacts` sync toggle — which is what the toggle is for. */
  | 'SYNCED'
  /** Never leaves. Nothing is classified this way yet; the class exists so
   *  the answer to "should this new field sync?" can be NO without needing a
   *  new mechanism first, which is when such questions get skipped. */
  | 'LOCAL_ONLY'

/**
 * Build a payload from a record and its rule table.
 *
 * DERIVED, not hand-listed — the point of the exercise. A hand-written payload
 * literal is the thing that fell behind the type three times on the call side;
 * a second one for contacts would be a fourth.
 *
 * `undefined` values are dropped so the payload matches what the old
 * whole-record spread produced: the stored record simply omits empty optional
 * keys, and adding explicit `undefined`s would change the JSON on the wire.
 */
export function buildEgressPayload<T extends object>(
  record: T,
  rules: { [K in keyof Required<T>]: FieldEgress }
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rules) as (keyof T)[]) {
    if (rules[key as keyof Required<T>] !== 'SYNCED') continue
    const value = record[key]
    if (value !== undefined) out[key as string] = value
  }
  return out
}
