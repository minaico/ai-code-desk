<#
.SYNOPSIS
  Stops the locally running Web Terminal processes.
.PARAMETER WebOnly
  Stop the web server but leave the PTY host (and every terminal session) alive.
#>
[CmdletBinding()]
param(
    [switch]$WebOnly,
    [int]$Port = 0
)

. "$PSScriptRoot\common.ps1"

if ($Port -le 0) { $Port = Get-WtPort }
$hostPort = if ($env:PTY_HOST_PORT) { [int]$env:PTY_HOST_PORT } else { 8777 }

function Stop-ByPort {
    param([int]$TargetPort, [string]$Label)
    $conns = Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-WtInfo "$Label - nothing listening on $TargetPort"
        return
    }
    foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.ProcessName -ne "node") {
            Write-WtWarn "$Label - port $TargetPort is owned by $($proc.ProcessName) (pid $procId); not touching it"
            continue
        }
        Stop-Process -Id $procId -Force
        Write-WtOk "$Label - stopped node pid $procId"
    }
}

Write-WtHeader "Stopping"

# -Port means the web port, but it is also what people reach for when the thing
# they mean to stop is the PTY host. Calling that "web server" and then adding
# "sessions survive" misreported the one action here that costs terminals.
$stoppingHost = ($Port -eq $hostPort)
$firstLabel = if ($stoppingHost) { "PTY host" } else { "web server" }
Stop-ByPort -TargetPort $Port -Label $firstLabel

if ($stoppingHost) {
    Write-WtWarn "That port is the PTY host: every terminal session on this machine was killed."
} elseif ($WebOnly) {
    Write-WtInfo "PTY host left running - sessions survive."
} else {
    Stop-ByPort -TargetPort $hostPort -Label "PTY host"
    Write-WtWarn "PTY host stopped: every terminal session was killed."
}
