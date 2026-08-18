# M27 + Tier 1 → 1.3.0 — full stage list, with elevated steps called out

Companion to [`M27-RUNBOOK.md`](M27-RUNBOOK.md) (the non-elevated commands) and
[`M27-tier1-recorder-handoff.md`](M27-tier1-recorder-handoff.md) (the *why*).

**Rule this whole file follows** (project `CLAUDE.md`, rule 6): elevated
operations — driver install/remove, `pnputil`, Test Signing, anything touching
`C:\ProgramData` ACLs — run in **your own** elevated terminal, never automated
from the assistant's shell. Every block below is written to be pasted into a
PowerShell window **you** opened as Administrator (right-click → *Run as
Administrator*, or `Start-Process pwsh -Verb RunAs`).

---

## Stage list, elevation marked per stage

| # | Stage | Elevated? | Where |
|---|---|---|---|
| 1 | `recorder.ts` checkpoint (4 properties, red-then-green) | No | Runbook §1 |
| 2 | Merge → `main` at 1.3.0 | No | Runbook §2 |
| 3 | Typecheck + full suite on merged main | No | Runbook §3 |
| 4 | Build installer + bundle-verify | No | Runbook §4 |
| 5 | Publish (tag push → CI → GitHub Release) | No | Runbook §5–6 |
| 6a | **Clean-slate verification: remove old install + driver** | **YES** | This file, §A |
| 6b | **Clean-slate verification: install fresh 1.3.0** | **YES** (NSIS) | This file, §B |
| 6c | **Optional: exercise the driver path too** (`install-denoiser.ps1`) | **YES** | This file, §C |
| 6d | Read back `kern_bridge_status.json` after the real call | No | This file, §D |
| — | Recovery if a stuck driver instance is left behind | **YES** | This file, §E |

Only 6a/6b/6c/E need elevation. Everything else — building, testing,
tagging, publishing — runs from a normal shell and is already covered in the
runbook.

---

## §A — Elevated: remove the current install, model, and driver

Paste this whole block into an **Administrator** PowerShell window. It is
scoped to remove only CallRise's own footprint — it does not touch anything
else on the machine.

```powershell
# --- A1: close the app so nothing holds the files open ---
Get-Process CallRiseAI -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process kern_bridge  -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# --- A2: uninstall via the app's own uninstaller if present (NSIS-generated) ---
$uninstaller = "C:\Users\User\AppData\Local\Programs\CallRiseAI\Uninstall CallRiseAI.exe"
if (Test-Path $uninstaller) {
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
    Write-Host "Ran NSIS uninstaller." -ForegroundColor Cyan
} else {
    Write-Host "No NSIS uninstaller found at expected path — will remove the folder directly." -ForegroundColor Yellow
}

# --- A3: remove the driver + denoiser via the staged uninstaller (elevated, self-checks) ---
$stagedUninstall = "C:\Users\User\AppData\Local\Programs\CallRiseAI\resources\virtualmic-win\uninstall-denoiser.ps1"
if (Test-Path $stagedUninstall) {
    & $stagedUninstall
} else {
    Write-Host "No staged uninstall-denoiser.ps1 found (app may already be gone) — continuing." -ForegroundColor Yellow
}

# --- A4: remove any leftover install directory ---
Remove-Item "C:\Users\User\AppData\Local\Programs\CallRiseAI" -Recurse -Force -ErrorAction SilentlyContinue

# --- A5: remove the model directory (this is what forces the false/passthrough
#         branch to be reachable on the fresh install — the whole point) ---
Remove-Item "C:\ProgramData\CallRiseAI" -Recurse -Force -ErrorAction SilentlyContinue

# --- A6: confirm the virtual mic driver is gone ---
Get-PnpDevice -FriendlyName "*CallRise*" -ErrorAction SilentlyContinue |
    Select-Object FriendlyName, InstanceId, Status

# --- A7: confirm nothing CallRise-related is left running or on disk ---
"--- processes ---"
Get-Process | Where-Object { $_.Name -match "CallRise|kern_bridge" }
"--- ProgramData ---"
Test-Path "C:\ProgramData\CallRiseAI"
"--- install dir ---"
Test-Path "C:\Users\User\AppData\Local\Programs\CallRiseAI"
"--- LOCALAPPDATA state (status file, logs) ---"
Get-ChildItem "$env:LOCALAPPDATA\CallRiseAI" -ErrorAction SilentlyContinue
```

Expect at the end: no `CallRise*` process, no `Get-PnpDevice` match, both
`Test-Path` checks `False`. If `Get-PnpDevice` still shows the virtual mic,
go to **§E** before continuing — installing on top of a stuck driver instance
produces the "duplicate `ROOT\MEDIA\0001` in Status: Error" state this project
has hit before.

---

## §B — Elevated: install the fresh 1.3.0 build

The NSIS installer itself (`oneClick: false`) will prompt UAC on launch — that
prompt **is** the elevation, so this can be started from a normal shell, but
starting it from the same elevated window keeps everything in one place and
avoids a second UAC prompt interrupting the sequence.

```powershell
# --- B1: locate the freshly built installer (adjust path if built elsewhere) ---
$installer = Get-ChildItem "C:\Users\User\Desktop\callrise-m27\dist\CallRise AI Windows.exe" -ErrorAction Stop
"Installing: $($installer.FullName)  ($([math]::Round($installer.Length/1MB,1)) MB, built $($installer.LastWriteTime))"

# --- B2: run it. Silent (/S) skips the directory-choice screen; drop /S to
#         watch it interactively instead, which is closer to what a real
#         first-time user sees. ---
Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait

# --- B3: confirm what landed, BEFORE starting the app — this is the real
#         stand-in for "what does a stranger's machine have right now" ---
$vmw = "C:\Users\User\AppData\Local\Programs\CallRiseAI\resources\virtualmic-win"
"--- resources/virtualmic-win/ as actually installed ---"
Get-ChildItem $vmw -ErrorAction SilentlyContinue |
    Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}, LastWriteTime
"--- ProgramData model (should be ABSENT — nothing has run install-denoiser.ps1) ---"
Test-Path "C:\ProgramData\CallRiseAI\Models\DeepFilterNet3_onnx.tar.gz"
```

Expect: `kern_bridge.exe` and `DeepFilterNet3_onnx.tar.gz` both present under
`virtualmic-win\`, and the ProgramData check `False`. That combination is
exactly what proves Tier 1 works with **no driver installed at all** — the
model came from the installer, not from the elevated driver path.

```powershell
# --- B4: launch the app and start a call with Tier 1 on ---
Start-Process "C:\Users\User\AppData\Local\Programs\CallRiseAI\CallRiseAI.exe"
Start-Sleep -Seconds 5

"--- once you've started a call with denoising ON, check status ---"
Get-Content "$env:LOCALAPPDATA\CallRiseAI\kern_bridge_status.json" -ErrorAction SilentlyContinue
```

Expect `"modelLoaded":true` and `"modelPath"` pointing **inside**
`resources\virtualmic-win\`, not ProgramData. Confirm in-app: the transcript is
producing text, and `sinkSent`/the level meter is climbing while you talk.

**This is the real end-to-end check the founder asked for in step 6** — a
genuinely fresh install, nothing pre-staged, a real call. Everything before
this point in the project was against a machine that had been hand-modified.

---

## §C — Elevated, optional: exercise the driver path too

Only needed if you also want to verify the **Zoom/Teams-facing** virtual
capture device (separate from Tier 1's own-audio pipe, which §B already
proved). Skip this if today's goal is just confirming Tier 1 itself.

```powershell
$vmw = "C:\Users\User\AppData\Local\Programs\CallRiseAI\resources\virtualmic-win"
& (Join-Path $vmw "install-denoiser.ps1")
```

It self-checks elevation and will refuse (not silently degrade) if not run as
Administrator, per `install-denoiser.ps1:159`.

---

## §D — Not elevated: read back what actually happened

Run from a normal shell, any time after a call:

```powershell
Get-Content "$env:LOCALAPPDATA\CallRiseAI\kern_bridge_status.json"
```

- `modelLoaded:true`, path inside `virtualmic-win\` → working as shipped.
- `modelLoaded:true`, path inside `ProgramData\` → fell back to the legacy
  location (only possible if §C was also run) — fine, but worth noting which
  path actually won.
- `modelLoaded:false` → passthrough. `modelPath` names the exact file it
  looked for and couldn't find. This is the state every new install would have
  hit before this release's fix.
- **File absent** → engine never started, or `%LOCALAPPDATA%` isn't writable.
  Check the process list and `virtualmic-win\` contents from §B3 again.

---

## §E — Elevated: recovery if a driver instance is stuck

Only needed if §A6 still shows a `CallRise` device, or Device Manager shows a
`ROOT\MEDIA\####` entry in a `Status: Error` state (a known overlapping-install
failure mode on this project).

```powershell
& "C:\Users\User\Desktop\CALLRISE AI\Windows-driver-samples\_clean_recovery.ps1"
```

Then re-run the confirmation block at the end of §A before proceeding to §B.

---

## Summary — what to paste, in order, when you're at the machine

1. Runbook §1–4 (recorder checkpoint → merge → suite → build) — **normal shell**
2. **§A above — elevated shell** (remove old install/model/driver)
3. **§B above — elevated shell** (install fresh 1.3.0, real call, read status)
4. Runbook §5–7 (tag, publish, confirm `latest.yml`, write release notes) — **normal shell**

§C and §E are situational, not part of the default path.
