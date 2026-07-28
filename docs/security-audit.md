# Security audit (M18 §5.3)

Two categories below, kept strictly apart:

- **Verified** — checked here, in this repo, with the result stated.
- **You must run** — needs a live Supabase project or a packaged build, and
  cannot be done from a container with neither. An unrun check is not a pass.

---

## Fixed in code

### Electron fuses — the highest-severity item

Without these, a signed and notarized CallRise AI is a general-purpose code
execution primitive that inherits the app's own permissions:

```
ELECTRON_RUN_AS_NODE=1 "/Applications/CallRise AI.app/Contents/MacOS/CallRise AI" -e '<anything>'
```

runs arbitrary JavaScript as us. macOS granted the microphone to _this bundle_,
so anything running inside it inherits that grant. For an app whose reason to
exist is holding mic access — and, with consent, the other party's audio — that
is the difference between a bug and a wiretap someone else can point at your
customers. The mic permission is also the one thing an attacker cannot quietly
obtain on their own: prompting for it draws attention, borrowing ours does not.

`scripts/apply-fuses.js`, wired as electron-builder's `afterPack` (before
signing, since flipping a fuse invalidates a signature):

| Fuse                                    | Set to | Closes                                                                                      |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `RunAsNode`                             | off    | the `ELECTRON_RUN_AS_NODE` escape hatch above                                               |
| `EnableNodeCliInspectArguments`         | off    | `--inspect`, which attaches a debugger to main and achieves the same thing more comfortably |
| `EnableEmbeddedAsarIntegrityValidation` | on     | editing `app.asar` in place                                                                 |
| `OnlyLoadAppFromAsar`                   | on     | sidestepping the above via an unpacked `app/` directory                                     |

The last two are a pair. Integrity-validating an archive that nobody is forced
to load is worth nothing, so enabling either alone leaves the door open.

### CSP as a response header

`session.defaultSession.webRequest.onHeadersReceived` in `src/main/index.ts`,
packaged builds only.

The `<meta>` tag in `index.html` was the only policy before, and it is not
equivalent: several directives are ignored when delivered that way
(`frame-ancestors` among them), and a meta tag only applies once the document
has parsed far enough to reach it.

This matters because **transcripts are attacker-influenced text** — the person
on the other end of the call chooses the words rendered in this window — and so
is every model response derived from them. `connect-src 'self'` is the
load-bearing directive: the renderer makes no network calls at all (Deepgram,
the AI providers, Supabase, Google and Outlook are all reached from main), so
injected script has nowhere to send what it steals.

Dev is deliberately excluded — Vite's HMR client needs inline scripts and a
websocket to the dev server, and breaking `npm run dev` to harden a build that
does not exist yet is a bad trade. The meta tag still covers dev.

---

## Verified here

### No `service_role` key ships

The only credential in the bundle is `src/main/default-config.ts`'s Supabase
key. Decoded rather than assumed:

```
role: anon    ref: fphvsuvpskqwkcpiocfz    exp: 2036-06-29
```

`role: anon`, which is the key designed to be public. No `service_role` key
appears anywhere in `src/`, and `.env` is excluded from the package.

**But this is exactly why the RLS audit below is not optional.** The anon key
is extractable from the shipped app in about thirty seconds, so it is not a
secret and was never meant to be one. Every guarantee about one user not
reading another user's calls rests on Postgres row-level security and nothing
else. RLS is off by default in Postgres; the shipped SQL turns it on, but only
the live database can say whether it is actually on there.

### No HTML-injection sink

`grep` for `innerHTML` and `dangerouslySetInnerHTML` across `src/`: **zero
occurrences**. Transcript and model text is rendered as React children
throughout, which escapes. The CSP header above is defence in depth against a
future component that changes this.

### RLS policy shape, as written in the repo

From `supabase/backup-schema.sql` and `supabase/2026-07-deals-and-scrub.sql`:

- Every policy is `user_id = auth.uid()`. There is **no `org_id` anywhere**, so
  the classic tenant-escape via a user-editable `user_metadata.org_id` does not
  exist in this schema.
- No policy uses `auth.role() = 'authenticated'` as its entire predicate — the
  single most common real cross-tenant leak.
- Every `insert` and `update` policy carries a matching `WITH CHECK`, so a row
  cannot be written into, or moved to, another user.
- **No views at all.** Views run as their owner and do not inherit RLS, so an
  analytics view over transcripts would be a full-table leak. There are none.
- One `SECURITY DEFINER` trigger function, already pinned with
  `set search_path = ''`.
- Storage: `bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text`.

This is the shape you want. It is still only the shape _in the repo_.

---

## You must run

### 1. Is RLS actually on, in the live database?

Supabase SQL editor. Expect **zero rows** from the first two.

```sql
-- Any table without RLS at all.
SELECT schemaname, tablename FROM pg_tables
WHERE schemaname IN ('public','storage') AND rowsecurity = false;

-- RLS on, but no policy — which denies everything, or denies nothing,
-- depending on how it is reached. Either way it is not what you designed.
SELECT t.tablename FROM pg_tables t
LEFT JOIN pg_policies p ON p.tablename = t.tablename
WHERE t.schemaname='public' AND t.rowsecurity AND p.policyname IS NULL;

-- Read them and check each one yourself.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies WHERE schemaname='public' ORDER BY tablename;
```

In the third result, look for: `qual` that is just `true` or
`auth.role() = 'authenticated'`; an INSERT or UPDATE row with `with_check`
null; anything referencing `user_metadata` (user-editable, therefore a tenant
escape).

### 2. Attack it, do not inspect it

The UI adds its own filters, which mask a missing policy completely. The only
test that means anything goes straight at PostgREST with a real anon-key JWT.

```bash
# Sign in as user A in the app, then take their access token.
A_TOKEN='<user A access_token>'
B_ROW='<the id of a row belonging to user B>'
URL='https://fphvsuvpskqwkcpiocfz.supabase.co'
ANON='<the anon key from default-config.ts>'

# READ — expect []
curl -s "$URL/rest/v1/backup_calls?id=eq.$B_ROW" \
  -H "apikey: $ANON" -H "Authorization: Bearer $A_TOKEN"

# UPDATE — expect [] (nothing matched) and no change to the row
curl -s -X PATCH "$URL/rest/v1/backup_calls?id=eq.$B_ROW" \
  -H "apikey: $ANON" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
  -d '{"title":"owned"}'

# INSERT into another user's account — expect a 403 / RLS violation
curl -s -X POST "$URL/rest/v1/backup_calls" \
  -H "apikey: $ANON" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"<user B uuid>","id":"attack-1","title":"x"}'

# DELETE — expect [] and the row still present afterwards
curl -s -X DELETE "$URL/rest/v1/backup_calls?id=eq.$B_ROW" \
  -H "apikey: $ANON" -H "Authorization: Bearer $A_TOKEN" \
  -H 'Prefer: return=representation'
```

Repeat for `backup_tasks`, `backup_events`, `backup_contacts`, `backup_deals`,
`backup_deal_stages`, `backup_knowledge`, `backup_settings`, and the
`attachments` storage bucket. Criterion 10 is met only when read, insert,
update **and** delete all fail on every one.

### 3. Confirm the packaged bundle

```bash
npx asar extract app.asar /tmp/x && grep -rn "service_role" /tmp/x
```

Expect no hits. A hit for the `anon` key is expected and fine.

### 4. Confirm the fuses actually flipped

```bash
npx @electron/fuses read --app "/Applications/CallRise AI.app"
# and the one that matters, from a shell:
ELECTRON_RUN_AS_NODE=1 "/Applications/CallRise AI.app/Contents/MacOS/CallRise AI" -e 'console.log(1)'
# expect the app to start normally, NOT to print 1
```

---

## Still open

- **Auto-updater.** Not a dependency yet, so CVE-2024-39698 does not apply and
  criterion 12's updater half is untestable. You chose to build it and then
  audit it; that is not done. When it is, the test that matters is a malformed
  or unsigned artifact being **refused** — in the 2020 Doyensec bypass a
  filename containing one quote caused a PowerShell parse error, the check
  returned null, and the update installed anyway. Any validation error must
  reject, never fail open. Treat `latest.yml` as untrusted input.
- **Criterion 11 — capture cannot start without a _persisted_ consent record.**
  Today the consent record lives in renderer memory for the duration of a call
  and only reaches disk on save. The retention guard means unconsented buyer
  turns can never be stored, and buyer capture is triple-gated, but the gate
  itself is process state rather than a durable record. Not met.
- **Audible in-call announcement.** The remote party cannot see an Electron
  window, so a UI banner is worth nothing to them. Twelve US states require
  all-party consent; Massachusetts and Pennsylvania carry criminal penalties.
  Not built.
- **BYO-key ZDR honesty.** Zero Data Retention is a property of the customer's
  own LLM organisation, not something this app can grant. Nothing in the app
  currently claims it — that must stay true. Note that Anthropic's ZDR also
  excludes the Batch API, the Files API and Covered Models, which require
  30-day retention.
