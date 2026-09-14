<#
.SYNOPSIS
  Local health check that works whether or not the scheduled tasks are installed.
#>
[CmdletBinding()]
param([int]$Port = 0)

. "$PSScriptRoot\common.ps1"

if ($Port -le 0) { $Port = Get-WtPort }
$hostPort = if ($env:PTY_HOST_PORT) { [int]$env:PTY_HOST_PORT } else { 8777 }
$installDir = Get-WtInstallDir

Write-WtHeader "Install"
Write-WtInfo "directory : $installDir"
Write-WtInfo "node      : $(Get-WtNodePath)"
if (Test-Path (Join-Path $installDir "dist\index.html")) { Write-WtOk "dist\ built" } else { Write-WtWarn "dist\ missing - run npm run build" }

Write-WtHeader "Processes"
foreach ($pair in @(@{ p = $Port; n = "web server" }, @{ p = $hostPort; n = "PTY host" })) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $pair.p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        Write-WtOk "$($pair.n) on port $($pair.p) (pid $($conn.OwningProcess) $($proc.ProcessName))"
    } else {
        Write-WtFail "$($pair.n) not listening on port $($pair.p)"
    }
}

Write-WtHeader "Health"
$health = Get-WtHealth -Port $Port
if ($health) {
    Write-WtOk "ok - node $($health.node), sessions $($health.sessions), uptime $([int]($health.uptimeMs/1000))s"
    if ($health.hostConnected) { Write-WtOk "PTY host connected" } else { Write-WtFail "PTY host NOT connected" }
} else {
    Write-WtFail "http://127.0.0.1:$Port/health did not answer"
}

Write-WtHeader "Configuration"
foreach ($v in @("PORT", "PTY_HOST_PORT", "WEB_TERMINAL_ROOTS", "WEB_TERMINAL_DATA")) {
    $machine = [Environment]::GetEnvironmentVariable($v, "Machine")
    $current = [Environment]::GetEnvironmentVariable($v, "Process")
    Write-WtInfo ("{0,-22} machine='{1}' process='{2}'" -f $v, $machine, $current)
}
$auth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD_HASH", "Machine")
if (-not $auth) { $auth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD", "Machine") }
if ($auth) { Write-WtOk "authentication configured" } else { Write-WtWarn "no password configured" }
