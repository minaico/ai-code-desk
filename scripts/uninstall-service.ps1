<#
.SYNOPSIS
  Stops and removes the Web Terminal scheduled tasks.
.PARAMETER KeepEnvironment
  Leave the machine-level WEB_TERMINAL_* variables in place.
#>
[CmdletBinding()]
param([switch]$KeepEnvironment)

. "$PSScriptRoot\common.ps1"
Assert-WtAdmin

Write-WtHeader "Removing scheduled tasks"
foreach ($name in @((Get-WtWebTaskName), (Get-WtHostTaskName))) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-WtInfo "$name not installed"
        continue
    }
    try { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-WtOk "removed $name"
}

if (-not $KeepEnvironment) {
    Write-WtHeader "Removing machine environment variables"
    foreach ($v in @("WEB_TERMINAL_PASSWORD", "WEB_TERMINAL_PASSWORD_HASH", "WEB_TERMINAL_ROOTS")) {
        if ([Environment]::GetEnvironmentVariable($v, "Machine")) {
            [Environment]::SetEnvironmentVariable($v, $null, "Machine")
            Write-WtOk "cleared $v"
        }
    }
    Write-WtInfo "PORT / PTY_HOST_PORT were left alone in case other software uses them."
}

Write-Host ""
Write-WtInfo "Any node.exe processes still running are left untouched. Use scripts\stop.ps1 to end them."
