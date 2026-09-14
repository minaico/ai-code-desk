<#
.SYNOPSIS
  Reports scheduled-task state, listening ports and /health for the Web Terminal.
#>
[CmdletBinding()]
param([int]$Port = 0)

. "$PSScriptRoot\common.ps1"

if ($Port -le 0) { $Port = Get-WtPort }
$hostPort = [Environment]::GetEnvironmentVariable("PTY_HOST_PORT", "Machine")
if (-not $hostPort) { $hostPort = "8777" }

Write-WtHeader "Scheduled tasks"
foreach ($name in @((Get-WtHostTaskName), (Get-WtWebTaskName))) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-WtWarn "$name not installed"
        continue
    }
    $info = Get-ScheduledTaskInfo -TaskName $name
    $line = "{0,-22} {1,-10} last run {2} result {3}" -f $name, $task.State, $info.LastRunTime, $info.LastTaskResult
    if ($task.State -eq "Running") { Write-WtOk $line } else { Write-WtWarn $line }
}

Write-WtHeader "Listening ports"
foreach ($p in @([int]$Port, [int]$hostPort)) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        Write-WtOk "$p listening on $($conn.LocalAddress) (pid $($conn.OwningProcess) $($proc.ProcessName))"
    } else {
        Write-WtFail "$p not listening"
    }
}

Write-WtHeader "Health"
$health = Get-WtHealth -Port $Port
if ($health) {
    Write-WtOk "web server ok - node $($health.node), $($health.sessions) session(s)"
    if ($health.hostConnected) { Write-WtOk "PTY host connected" } else { Write-WtFail "PTY host NOT connected" }
} else {
    Write-WtFail "no answer from http://127.0.0.1:$Port/health"
}

Write-WtHeader "Recent log"
$logDir = Join-Path (Get-WtInstallDir) ".data\logs"
if (Test-Path $logDir) {
    Get-ChildItem $logDir -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 2 | ForEach-Object {
        Write-Host "  $($_.Name)" -ForegroundColor DarkGray
        Get-Content $_.FullName -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
} else {
    Write-WtInfo "no logs yet ($logDir)"
}
