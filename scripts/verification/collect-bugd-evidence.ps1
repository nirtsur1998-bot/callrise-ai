# M37 Stage 2 -- THE ONE SCRIPT TO RUN ON THE WORK PC WHEN A CALL COMES OUT THIN.
#
# The founder's ask: "One script I run on the work PC that collects everything,
# so I cannot send the wrong file."
#
# WHAT IT COLLECTS -- and the design rule behind it: this script does NO
# analysis. It extracts the SHAPE of each call (per-segment metadata) and
# nothing else. The verdict logic lives in exactly one place,
# bugd-triage.mjs, and is applied afterwards to whatever this collects. A
# second copy of that logic here, in a second language, would be a second
# source of truth about the same bug, and this project has already paid for
# that mistake once (bugd-partition.mjs carries the warning in its header).
#
# WHAT IS DELIBERATELY NOT IN THE OUTPUT -- check this yourself before sending:
#   NO transcript text. Every segment's words are replaced by a word COUNT.
#   NO call titles, NO contact names, NO summaries, NO coaching notes.
#   NO API keys, NO account data, NO settings prose.
# What IS in it: per-call and per-segment numbers, timestamps, the audio device
# names on this PC, and the app version. Open the .json in Notepad and read it.
#
# REQUIREMENTS: none. Windows PowerShell 5.1, which every Windows PC has. It
# deliberately does not need Node, because the work PC has the app, not a dev
# environment.
#
#   powershell -ExecutionPolicy Bypass -File collect-bugd-evidence.ps1
#
# Optional: -CallsDir <path> if the profile is somewhere unusual,
#           -Out <path>      to choose where the zip lands (default: Desktop).

[CmdletBinding()]
param(
  [string]$CallsDir = (Join-Path $env:APPDATA 'sales-os\calls'),
  [string]$Out = ([Environment]::GetFolderPath('Desktop'))
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$work = Join-Path ([System.IO.Path]::GetTempPath()) "bugd-evidence-$stamp"
New-Item -ItemType Directory -Path $work -Force | Out-Null

Write-Host "CallRise -- BUG-D evidence collector"
Write-Host "  reading: $CallsDir"

if (-not (Test-Path $CallsDir)) {
  Write-Host ""
  Write-Host "  Could not find the calls folder at:"
  Write-Host "    $CallsDir"
  Write-Host "  Re-run with:  -CallsDir <the right path>"
  exit 2
}

# ---- 1. call shapes: metadata only, never words --------------------------
$files = Get-ChildItem -Path $CallsDir -Filter '*.json' -File
$shapes = New-Object System.Collections.ArrayList
$skippedDeleted = 0
$skippedBad = 0

foreach ($f in $files) {
  try {
    $c = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    $skippedBad++
    continue
  }
  if ($c.deleted -eq $true) { $skippedDeleted++; continue }

  $segs = New-Object System.Collections.ArrayList
  if ($c.segments) {
    foreach ($s in $c.segments) {
      # the ONLY thing taken from `text` is how many words it had
      $wordCount = 0
      if ($s.text) { $wordCount = ([regex]::Matches([string]$s.text, '\S+')).Count }
      [void]$segs.Add([ordered]@{
        speaker    = $s.speaker
        channel    = $s.channel
        epoch      = $s.epoch
        role       = $s.role
        kind       = $s.kind
        confidence = $s.confidence
        unlabelled = $s.unlabelled
        words      = $wordCount
        # a gap marker's DURATION is a number and is the point of the marker;
        # it is taken from the text because that is where the app stores it
        gapSeconds = $(if ($s.kind -eq 'gap' -and [string]$s.text -match '\[gap:\s*([\d.]+)\s*s\]') { [double]$Matches[1] } else { $null })
      })
    }
  }

  [void]$shapes.Add([ordered]@{
    id                  = $c.id
    createdAt           = $c.createdAt
    endedAt             = $c.endedAt
    durationMs          = $c.durationMs
    speakerCount        = $c.speakerCount
    hasSummary          = [bool]$c.summary
    hasCoaching         = [bool]$c.coaching
    recordOtherParty    = $(if ($c.consent) { $c.consent.recordOtherParty } else { $null })
    segmentCount        = $segs.Count
    segments            = $segs
  })
}

Write-Host "  read $($files.Count) files: $($shapes.Count) live calls, $skippedDeleted deleted, $skippedBad unreadable"

# -Depth matters: PowerShell's ConvertTo-Json truncates at depth 2 by default
# and would silently emit the string "System.Collections.Hashtable" for every
# segment. Measured the hard way on this project more than once.
# NO BOM. Set-Content -Encoding UTF8 on PowerShell 5.1 always writes a byte
# order mark, and JSON.parse rejects it outright -- the evidence would have
# arrived unreadable. Measured, not assumed: the first collected file failed
# to parse on exactly this.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $work 'call-shapes.json'), ($shapes | ConvertTo-Json -Depth 8), $utf8NoBom)

# ---- 2. this machine: the facts no call record carries -------------------
$env_lines = New-Object System.Collections.ArrayList
[void]$env_lines.Add("collected: $(Get-Date -Format o)")
[void]$env_lines.Add("windows: $([System.Environment]::OSVersion.VersionString)")
[void]$env_lines.Add("powershell: $($PSVersionTable.PSVersion)")
[void]$env_lines.Add("machine cores: $($env:NUMBER_OF_PROCESSORS)")
[void]$env_lines.Add("calls dir: $CallsDir")
[void]$env_lines.Add("")
[void]$env_lines.Add("== installed CallRise versions ==")
# Measured, not guessed: the per-user NSIS install lands in
# %LOCALAPPDATA%\Programs\CallRiseAI (no space, no hyphen), and the updater
# stages the next build in %LOCALAPPDATA%\callrise-ai-updater\pending. The
# first version of this block guessed two other spellings, found neither, and
# printed an EMPTY section that read exactly like "no CallRise installed" --
# which is why it is a search now rather than a list of hopeful paths.
$exeFound = $false
foreach ($root in @("$env:LOCALAPPDATA\Programs", "$env:LOCALAPPDATA\callrise-ai-updater", "$env:PROGRAMFILES", "${env:PROGRAMFILES(X86)}")) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Filter 'CallRise*.exe' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue | ForEach-Object {
    $exeFound = $true
    [void]$env_lines.Add("  $($_.FullName)")
    [void]$env_lines.Add("      version $($_.VersionInfo.FileVersion)   built $($_.LastWriteTime)")
  }
}
if (-not $exeFound) { [void]$env_lines.Add("  (no CallRise executable found in the usual places)") }
[void]$env_lines.Add("")
[void]$env_lines.Add("== audio devices (hardware names only) ==")
[void]$env_lines.Add("   BUG-D hypothesis 3 was 'input device' and the call record has never carried it.")
try {
  Get-CimInstance Win32_SoundDevice -ErrorAction Stop | ForEach-Object {
    [void]$env_lines.Add("  $($_.Name)  [$($_.Status)]")
  }
} catch { [void]$env_lines.Add("  (could not enumerate: $($_.Exception.Message))") }
try {
  Get-PnpDevice -Class 'AudioEndpoint' -ErrorAction Stop | ForEach-Object {
    [void]$env_lines.Add("  endpoint: $($_.FriendlyName)  [$($_.Status)]")
  }
} catch { [void]$env_lines.Add("  (no AudioEndpoint enumeration on this host)") }
[void]$env_lines.Add("")
[void]$env_lines.Add("== is the CallRise virtual mic present? ==")
try {
  $vm = Get-PnpDevice -ErrorAction Stop | Where-Object { $_.FriendlyName -like '*CallRise*' }
  if ($vm) { $vm | ForEach-Object { [void]$env_lines.Add("  $($_.FriendlyName)  [$($_.Status)]") } }
  else { [void]$env_lines.Add("  not installed") }
} catch { [void]$env_lines.Add("  (could not check)") }

[System.IO.File]::WriteAllText((Join-Path $work 'machine.txt'), ($env_lines -join "`r`n"), $utf8NoBom)

# ---- 3. say plainly what this is -----------------------------------------
@"
BUG-D evidence, collected $stamp

WHAT THIS IS
  call-shapes.json   one entry per live call: timing, and per segment the
                     channel, epoch, role, confidence, gap length, and HOW MANY
                     WORDS it had. Never the words themselves.
  machine.txt        Windows version, installed CallRise build, and the audio
                     device names on this PC.

WHAT IS NOT IN HERE
  No transcript text. No call titles. No contact names or numbers. No
  summaries or coaching notes. No API keys. No account data. No settings.
  You can open both files in Notepad and read every line before sending.

WHY THE WORDS ARE NOT INCLUDED
  BUG-D is about words that are MISSING. Their count and their channel answer
  it; their content does not. Sending customer speech would add risk and no
  information.

IF THE LOGS ARE ALSO WANTED
  The app has its own support bundle (Settings, near the bottom) which
  collects the application logs through a scrubber built for that purpose.
  This script deliberately does not copy logs, so that no unscrubbed prose can
  leave this machine by accident.
"@ | Set-Content -LiteralPath (Join-Path $work 'README.txt') -Encoding UTF8

# ---- 4. one file to send -------------------------------------------------
$zip = Join-Path $Out "bugd-evidence-$stamp.zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
Remove-Item -LiteralPath $work -Recurse -Force

Write-Host ""
Write-Host "  DONE. Send this one file:"
Write-Host "    $zip"
Write-Host ""
Write-Host "  It contains no transcript text. Open it and check before sending."
