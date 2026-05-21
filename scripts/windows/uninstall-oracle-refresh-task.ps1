#Requires -Version 5.1
<#
.SYNOPSIS
  Remove the MuHaven Wave 5 Q2 oracle-refresh Windows Task Scheduler entry.
#>
[CmdletBinding()]
param(
  [string] $TaskName = 'MuHaven\OracleRefresh'
)

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  Write-Host "Task '$TaskName' not found -- nothing to do."
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'."
