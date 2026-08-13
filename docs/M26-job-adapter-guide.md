# Wiring a new operation onto the job system

M26 Phase 5. A practical guide for whoever migrates the next long-running
operation onto `JobManager` — written for M25-style future work (Sales
Brain grew several background operations of its own), but the pattern is
the same for any feature. Everything here is the pattern Phase 3 already
used ~15 times across this codebase; this doc just writes it down in one
place instead of leaving the next author to reverse-engineer it from
`calls.ts`/`backup.ts`/`crm-note-generator-ipc.ts`.

If you're migrating an operation that already exists (not writing a new
one), read the "Migrating an existing operation" section first — the
sequencing matters more than the mechanics.

## Do you need this at all?

Not every async operation belongs on the job queue. Ask:

- **Does it take long enough that a rep might navigate away, or want to
  cancel it, or want to see it's still running?** A sub-second IPC round
  trip doesn't need this.
- **Is it worth surfacing in the Activity Center?** If the answer is "the
  rep would never want to know this ran," consider whether it even needs
  to be a job — see backup.ts's own periodic sync, which deliberately
  stays OFF the job system (a plain `setInterval`) specifically to avoid
  burying the 500-job retention cap in 144 heartbeats/day. A job type is
  for something a rep would recognize as "a thing that happened," even if
  it's `silent: true` and normally invisible.
- **Does it call an AI provider, hit the network, or otherwise take
  unpredictable time?** These are exactly the operations that benefit from
  a lane, a cancellation signal, and a wall-clock ceiling.

## The five things every adapter needs

### 1. A job type constant

```ts
export const MY_THING_JOB_TYPE = 'myFeature:doTheThing'
```

Namespace-colon-verb, matching every existing job type (`backup:sync`,
`calls:summarize`, `crmNote:generate`, `salesBrain:nightlyConsolidation`,
`deals:assessRisk`, `calendar:reconcile`, `updater:download`). The
namespace prefix is also the de facto "category" grouping used elsewhere
in the job system (see the notification-preferences discussion below) —
pick a namespace that matches your feature's other job types if it has
any.

### 2. A lane

```ts
export type JobLane = 'LIVE' | 'INTERACTIVE' | 'BATCH' | 'MAINTENANCE'
```

| Lane | Concurrency (user-adjustable, Settings → App) | For |
|---|---|---|
| `LIVE` | Unbounded, never queued behind anything, never user-adjustable | The live call itself. Nothing else belongs here — a live call must never wait. |
| `INTERACTIVE` | 2 by default | Something the rep clicked and is waiting on right now: summarize, generate a note, draft tasks. |
| `BATCH` | 1 by default | Something the rep started but isn't staring at: a scan, an import. |
| `MAINTENANCE` | 1 by default | Background housekeeping the rep never asked for directly: backup's manual "Sync now" job, Sales Brain's nightly consolidation, the embedding warm-up. |

Get this wrong in the "too eager" direction (e.g. `LIVE` for something
that isn't the actual call) and you defeat the one guarantee the milestone
exists to protect. Get it wrong in the "too generous" direction (e.g.
`INTERACTIVE` for background housekeeping) and a rep-triggered action
queues up behind work they never asked to wait on.

### 3. Registration — idempotent, guarded, called from your own `registerXxx()`

```ts
import { getJobManager } from '../jobs/instance'

let registered = false

export function registerMyFeature(): void {
  if (registered) return
  registered = true

  getJobManager().registerType<MyThingInput, MyThingResult>({
    type: MY_THING_JOB_TYPE,
    lane: 'INTERACTIVE',
    titleFor: (input) => `Doing the thing for ${input.targetName}`,
    targetRefFor: (input) => input.targetId, // lets dedup-on-enqueue and Job.targetRef work
    cancellable: true, // see the section below before setting this
    executor: {
      kind: 'inline-async',
      run: async (input, handle) => {
        handle.reportProgress({ mode: 'stages', stageLabel: 'Doing the thing…' })
        const result = await doTheActualWork(input, { signal: handle.signal })
        return result
      }
    }
  })
}
```

Call `registerMyFeature()` from `index.ts`'s startup sequence, **after**
`jobManager = new JobManager(); setJobManager(jobManager)` — every
`registerXxx()` that touches the job system runs after that line, never
before. If your feature is gated by a settings flag (Sales Brain, ambient
detection, ...), register the job type unconditionally but gate
*enqueueing* on the flag — that keeps the type available for a settings
toggle flipped mid-session without needing a restart.

`Job.input` must be JSON-serializable (it's persisted to disk for
crash-resume). Don't put live objects, functions, or class instances in
it.

### 4. Cancellation — earn `cancellable: true`, don't default to it

**This is the mistake BUG-060 found across 10 of 12 registered job types**:
`cancellable` used to default to `true`, and the UI showed a Cancel button
based on that flag alone — regardless of whether the executor's `run()`
function actually *read* `handle.signal` anywhere. Pressing Cancel removed
the job from the Activity Center and marked it cancelled, while the work
kept running underneath, to completion, still spending whatever AI-provider
quota it would have anyway.

The rule now: **only set `cancellable: true` if `handle.signal` is
genuinely threaded into every awaited network/AI call inside `run()`.**
Every `fetch`-like call in this codebase's AI layer already accepts an
`AbortSignal` (`completeWithFallback({ ..., signal: handle.signal })`, or
pass it explicitly into whatever SDK call you're wrapping). If your
operation has no natural abort point (a single synchronous DB write, a
tiny in-memory transform), set `cancellable: false` and don't offer a
button that lies.

If you need real, forced termination (not cooperative — genuinely CPU-heavy
work that won't check a signal on its own), `JobManager` also supports a
worker-thread execution kind with `worker.terminate()`. Nothing in this
codebase needs that yet; look at `JobManager.ts`'s own doc comments if you
do.

### 5. Enqueueing — from an IPC handler or a cascade, with dedup

```ts
// Rep-triggered, from a renderer IPC call:
ipcMain.handle('myFeature:doTheThing', (_e, input: MyThingInput) => {
  return enqueueMyThing(input)
})

function enqueueMyThing(input: MyThingInput): Job {
  // Dedup: don't start a second one if an identical job is already
  // running or queued (targetRef + type match) — see calls.ts's
  // summarize enqueue for the canonical version of this check.
  const manager = getJobManager()
  const existing = manager
    .list()
    .find(
      (j) =>
        j.type === MY_THING_JOB_TYPE &&
        j.targetRef === input.targetId &&
        (j.state === 'running' || j.state === 'queued')
    )
  if (existing) return existing
  return manager.enqueue(MY_THING_JOB_TYPE, input)
}
```

For a **cascade** (one job type triggering another on success — see
`calls.ts`'s summarize → auto-CRM-note chain), just call
`getJobManager().enqueue(NEXT_JOB_TYPE, input)` from inside the first
job's `run()`, after its own work succeeds. Don't await the cascade job —
enqueueing starts it independently.

For a **recurring/idle** trigger (nightly, or "when the system's been idle
a while") — don't hand-roll a timestamp file. Use `jobs/scheduler.ts`'s
`Scheduler` via `jobs/scheduler-instance.ts`'s `getScheduler()`:

```ts
import { getScheduler } from '../jobs/scheduler-instance'

getScheduler().registerRecurring({
  name: 'myFeature:nightlyThing', // unique — this is the persistence key
  intervalMs: 20 * 60 * 60 * 1000,
  run: () => enqueueMyThing(input) // synchronous; do async work fire-and-forget inside
})
```

One thing to know before reaching for this: `Scheduler` records a spec's
"last ran" timestamp the moment it's **triggered**, not after `run()`
finishes — so a failed pass won't retry sooner than the next full
`intervalMs` window. Fine for best-effort maintenance (see
`memory-runtime.ts`'s nightly consolidation, the first real caller); think
twice if your operation needs "retry soon after a failure" semantics —
that's not what `registerRecurring` gives you today.

## Other flags worth knowing about

- **`silent: true`** — the job still appears in the Activity Center and
  still counts against the 500-job retention cap, but its completion
  doesn't trigger a toast/notification. Use for housekeeping the rep never
  asked for and can't act on (`salesBrain:nightlyConsolidation`,
  `salesBrain:warmUpEmbeddings` is the one exception — see its own doc
  comment for why THAT one is deliberately *not* silent).
- **`retainUntilConsumed: true`** — the job survives the normal
  auto-pruning/dismiss flow until your own feature-specific "the rep has
  dealt with this" logic clears it. Use when a job holds real,
  already-paid-for AI output the rep hasn't reviewed yet (draft CRM notes,
  proposed tasks) — see BUG-052's writeup in the Bug Tracker for exactly
  what goes wrong without this (a generic "Clear history" button silently
  destroying an unreviewed draft, with no way to know it ever existed).
  `JobManager.dismiss()` refuses to clear a job like this on its own; only
  your feature's own "consumed" path can.
- **`handle.checkpoint(data)` / `handle.lastCheckpoint`** — for a job whose
  work can be resumed mid-way after a crash (rather than restarted from
  scratch). Most adapters don't need this; the past-calls scan is the
  existing example if you do.

## Notification categories

There's currently no explicit "category" field on `Job` — the de facto
grouping every existing consumer uses is the job type's own namespace
prefix (`backup:`, `salesBrain:`, `calls:`, `crmNote:`, ...). If you're
building per-category notification filtering (Phase 5 shipped only a
single master on/off toggle for the OS-level popup — see
`jobs/activity.ts`'s `isJobNativeNotificationsEnabled()` gate), you'll need
to either parse this prefix or add a real `category` field to
`JobTypeDefinition`/`Job` (mirroring how `silent`/`cancellable`/
`retainUntilConsumed` were each added deliberately, with their own doc
comment, rather than inferred). Don't invent a second meaning for
`lane` — it's a concurrency control, not a notification category, even
though they often correlate.

## Migrating an existing operation

If the operation already exists as a plain async function (not yet a
job), the sequencing that matters:

1. **Register the job type first**, with the executor wrapping the
   existing function unchanged. Ship this alone if you can — it's low
   risk (the operation behaves identically, just visible now) and easy to
   verify in isolation.
2. **Switch the trigger site(s)** (an IPC handler, a startup hook, a
   cascade) to enqueue instead of calling the function directly. Add the
   dedup check here if concurrent duplicate runs were ever possible
   before.
3. **Only then** consider `cancellable: true` — that requires actually
   threading `handle.signal` into the operation's own internals, which is
   real surgery on existing code, not adapter boilerplate. Don't bundle it
   into step 1 or 2; a job type that's visible-but-not-yet-cancellable is
   already strictly better than not being a job at all, and rushing
   cancellation wiring is exactly how BUG-060's "button that lies" class
   of bug gets introduced.

## Testing

Every existing adapter's own logic (dedup checks, gating, the executor
body) is unit-testable by mocking `../jobs/instance`'s `getJobManager` to
return a fake with `registerType`/`enqueue`/`list` spies — see
`src/main/memory/__tests__/memory-runtime-nightly.test.ts` for a worked
example that also mocks `jobs/scheduler-instance` for the recurring-spec
case. `JobManager` itself (lane limits, priority, cancellation, crash
resume) is already covered by `JobManager.test.ts` — you don't need to
re-prove the queue engine works, only that your adapter calls it
correctly with the right lane/cancellable/input shape.
