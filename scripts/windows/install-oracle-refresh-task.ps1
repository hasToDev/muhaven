#Requires -Version 5.1
<#
.SYNOPSIS
  Install the MuHaven Wave 5 Q2 oracle-refresh Windows Task Scheduler entry.

.DESCRIPTION
  Registers a scheduled task that runs
  `development/ORACLE_DATA_MINE/scripts/refresh-and-ingest.sh` every 8 hours
  under Git Bash, scraping rwa.xyz and ingesting the result to the prod
  backend. See that script's header comment for the full configuration model.

  Three daily triggers at 07:00 / 15:00 / 23:00 local (approx 00 / 08 / 16
  UTC for a UTC+7 operator) -- explicit, DST-resistant, and tweakable in the
  GUI
  without re-running the installer. `LogonType=Interactive` keeps the
  headed-Chromium scrape on the user's interactive desktop session.

.PARAMETER TaskName
  Task path (folder + name) under the Task Scheduler library.
  Default: `MuHaven\OracleRefresh`.

.PARAMETER BashPath
  Absolute path to Git Bash's `bash.exe`.
  Default: `C:\Program Files\Git\bin\bash.exe`.

.PARAMETER User
  Windows user under whose session the task runs. Default: `$env:USERNAME`.

.EXAMPLE
  pwsh scripts\windows\install-oracle-refresh-task.ps1

.EXAMPLE
  # Verify after install
  Get-ScheduledTask -TaskName 'MuHaven\OracleRefresh' | Get-ScheduledTaskInfo

.EXAMPLE
  # Fire a one-off manual run
  Start-ScheduledTask -TaskName 'MuHaven\OracleRefresh'
#>
[CmdletBinding()]
param(
  [string] $TaskName = 'MuHaven\OracleRefresh',
  [string] $BashPath = 'C:\Program Files\Git\bin\bash.exe',
  [string] $User = $env:USERNAME
)

$ErrorActionPreference = 'Stop'

Write-Host "Installing scheduled task '$TaskName'..."

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir '..\..')
$BashScript = Join-Path $RepoRoot 'scripts\refresh-and-ingest.sh'

if (-not (Test-Path $BashScript)) {
  throw "refresh-and-ingest.sh not found at $BashScript -- repo layout changed?"
}
if (-not (Test-Path $BashPath)) {
  throw "Git Bash not found at $BashPath. Pass -BashPath if installed elsewhere."
}

# Parse-check the wrapper BEFORE registering. Catches syntax errors,
# UTF-16 BOM, half-edited rewrites, etc. Without this guard the broken
# wrapper would silently fail every 8h with no Telegram alert (the
# alert path lives inside the wrapper that won't parse).
Write-Host "  parse-check: $BashScript"
& $BashPath -n $BashScript
if ($LASTEXITCODE -ne 0) {
  throw "bash -n reported errors in $BashScript (exit $LASTEXITCODE). Fix the wrapper before registering the scheduled task."
}

# Convert Windows path to Git-Bash-style ('D:\foo\bar' -> '/d/foo/bar')
# Only drive-letter paths are supported. UNC (`\\server\share\...`) and
# remote PSDrives do not have a stable Git Bash mapping and would silently
# generate garbage paths the scheduled task would then fail to find.
# Convert-Path returns the provider-native form without `Provider::` prefix
# (Resolve-Path can return e.g. `Microsoft.PowerShell.Core\FileSystem::D:\...`
# under exotic PSDrive setups).
function ConvertTo-BashPath {
  param([string] $Path)
  $abs = Convert-Path -LiteralPath $Path
  if ($abs -notmatch '^[A-Za-z]:\\') {
    throw "ConvertTo-BashPath only supports drive-letter paths; got '$abs'. If the repo lives on UNC / a mapped drive, point -BashPath at a drive-letter location or move the repo."
  }
  $drive = $abs.Substring(0, 1).ToLower()
  $rest = $abs.Substring(2) -replace '\\', '/'
  return "/$drive$rest"
}

$BashScriptUnix = ConvertTo-BashPath $BashScript
$RepoRootWin = $RepoRoot.Path

Write-Host "  bash:        $BashPath"
Write-Host "  script:      $BashScriptUnix"
Write-Host "  working-dir: $RepoRootWin"

# `-l` runs a login shell so /etc/profile.d and ~/.bashrc set up PATH for
# node/npm/playwright. Single-quotes around the script path keep bash happy
# if it ever moves under a directory with a space in the name.
$BashArgs = "-l -c `"exec '$BashScriptUnix'`""

$Action = New-ScheduledTaskAction `
  -Execute $BashPath `
  -Argument $BashArgs `
  -WorkingDirectory $RepoRootWin

# Three daily triggers -- easier to reason about than one Repetition
# block, and the GUI shows them as three explicit rows. Each trigger
# fires in LOCAL time; 07:00/15:00/23:00 matches 00/08/16 UTC for the
# UTC+7 operator. If the box was off across a window, Task Scheduler
# fires AT MOST ONE catch-up run after wake (not one per missed window)
# -- which is the desired behaviour since the scrape is idempotent and
# we don't want a triple-back-to-back Chromium burst.
$Triggers = @(
  (New-ScheduledTaskTrigger -Daily -At '07:00'),
  (New-ScheduledTaskTrigger -Daily -At '15:00'),
  (New-ScheduledTaskTrigger -Daily -At '23:00')
)

$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

# Interactive token -- refresh:all spawns HEADED Chromium and needs the
# user's interactive desktop session. Running under SYSTEM would either
# block on a non-existent display or render in session 0 (invisible).
# Caveat: an Interactive task only fires when the user is logged on; if
# the operator is logged off across all three trigger times the day has
# no runs at all. The homelab `oracle-staleness-check.sh` cron (28h NAV
# staleness threshold) is the load-bearing backstop for "Q2 never fired".
$Principal = New-ScheduledTaskPrincipal `
  -UserId $User `
  -LogonType Interactive `
  -RunLevel Limited

$Description = @"
MuHaven Wave 5 Q2 -- scrape rwa.xyz oracle data every 8h and ingest to prod backend.
Runs: $BashScriptUnix
Logs: development/ORACLE_DATA_MINE/_debug/cron-runs/<UTC>.log
History: development/ORACLE_DATA_MINE/_debug/refresh-history.log
"@

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Triggers `
  -Settings $Settings `
  -Principal $Principal `
  -Description $Description `
  -Force | Out-Null

Write-Host ""
Write-Host "Installed. Verify with:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "Manual one-off run (also useful for first-time smoke):"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Uninstall:"
Write-Host "  pwsh $ScriptDir\uninstall-oracle-refresh-task.ps1"
