<#
.SYNOPSIS
  Stops the Web Terminal, however it was started.
.DESCRIPTION
  There are two ways this app runs: as the two scheduled tasks that
  install-service.ps1 creates, and as plain node processes started by
  start.ps1. This stops whichever is actually there.

  It used to stop only the tasks. On a machine where start.ps1 had been used,
  it printed "not installed", stopped nothing, and then warned that stopping
  the PTY host kills every session - so it read like it had done the thing it
  had not done, and the terminals were still running afterwards.
.PARAMETER WebOnly
  Stop only the web server. Terminal sessions keep running in the PTY host.
#>
[CmdletBinding()]
param([switch]$WebOnly)

. "$PSScriptRoot\common.ps1"

Write-WtHeader "Stopping Web Terminal"

$webPort = Get-WtPort
# Resolved the way start-remote-host.ps1 resolves it. A machine that only hosts
# terminals for another one usually has PTY_HOST_PORT set machine-wide, and a
# process-scope lookup does not see that - it would then look on 8777, find
# nothing, and report success while the host kept running.
$hostPort = if ($env:PTY_HOST_PORT) {
    [int]$env:PTY_HOST_PORT
} else {
    $configured = [Environment]::GetEnvironmentVariable("PTY_HOST_PORT", "Machine")
    if ($configured) { [int]$configured } else { 8777 }
}

<# Whoever is listening on the port is the thing to stop. Found by port rather
   than by image name because every session, and node itself, is also node.exe:
   stopping those by name would take the whole machine's node with it. #>
function Stop-ByPort([int]$port, [string]$label) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $conn) {
        Write-WtInfo "$label not running (nothing listening on $port)"
        return $false
    }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    try {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
        Write-WtOk "stopped $label (pid $($conn.OwningProcess)$(if ($proc) { ", $($proc.ProcessName)" }))"
        return $true
    } catch {
        Write-WtFail "could not stop $label (pid $($conn.OwningProcess)): $($_.Exception.Message)"
        return $false
    }
}

$targets = if ($WebOnly) {
    @(@{ Task = (Get-WtWebTaskName); Port = $webPort; Label = 'web server' })
} else {
    @(
        @{ Task = (Get-WtWebTaskName);  Port = $webPort;  Label = 'web server' }
        @{ Task = (Get-WtHostTaskName); Port = $hostPort; Label = 'PTY host' }
    )
}

foreach ($t in $targets) {
    $task = Get-ScheduledTask -TaskName $t.Task -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $t.Task -ErrorAction SilentlyContinue
        Write-WtOk "stopped $($t.Task)"
        Start-Sleep -Milliseconds 500
    }
    # Either way, make sure the port is actually free: a scheduled task that
    # was started by hand, or a leftover from a previous run, still holds it.
    Stop-ByPort $t.Port $t.Label | Out-Null
}

if ($WebOnly) {
    Write-WtInfo "PTY host left running - open terminals and Claude Code sessions are untouched."
} else {
    Write-WtWarn "The PTY host is stopped: every terminal session is gone."
}
