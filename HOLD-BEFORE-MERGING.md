# HOLD — do not merge this branch as-is

**Founder's instruction, 2026-09-05:** this branch stays held until the BUG-164
echo dry run (`echo-dry-run.ts`) has been run on the founder's own calls and
its verdict accepted. When it does merge, it needs a **reconciliation**, not a
merge:

| commit | what it carries | what happened on `main` since |
|---|---|---|
| `af9eb5c` BUG-164 | drop the microphone's echo of the other party | nothing conflicting — **keep** |
| `984f36f` BUG-167 | let the Sales Brain say "not relevant" | nothing conflicting — **keep** |
| `7d88fc5` BUG-165 | the cue column STACKS below a threshold | `main` fixed BUG-165 differently (a measured padding reservation, v1.8.x) and M35 then folded the Voice AI rail below 1120px (BUG-171). **Re-decide**: do not apply blindly. |
| `30293c6` BUG-169 | an older "failed push surfaces" fix in `events.ts` + Month/WeekGrid | **superseded** by M35's BUG-169 (`526e0dd`, `1ed88d2`, `a80d2cf`): marker + dialog + Activity row + orphaning. **Drop this commit.** |
| `1ce6773` echo dry run | the dry-run script | keep |

Suggested route: cherry-pick `af9eb5c`, `984f36f`, `1ce6773` onto a fresh branch
off `main`; resolve `events.ts` in favour of `main`; treat `7d88fc5` as a new
proposal against the current live screen.
