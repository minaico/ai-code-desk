<#
.SYNOPSIS
  Starts the PTY host (detached) and the web server in this console.
.DESCRIPTION
  Use this for a manual/foreground run. For an unattended server install use
  scripts\install-service.ps1 instead.

  Ctrl+C stops only the web server; terminal sessions keep running inside the
  PTY host, which is exactly the point of the split architecture.
.PARAMETER Foreground
  Also run the PTY host in this console (both stop together).
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$Password = "",
    [string]$Roots = "",
    [switch]$Foreground
)

. "$PSScriptRoot\common.ps1"
$installDir = Get-WtInstallDir
$node = Get-WtNodePath

if ($Port -gt 0) { $env:PORT = "$Port" }
if ($Password) { $env:WEB_TERMINAL_PASSWORD = $Password }
if ($Roots) { $env:WEB_TERMINAL_ROOTS = $Roots }

if (-not (Test-Path (Join-Path $installDir "dist\index.html"))) {
    Write-WtWarn "dist\ is missing - run 'npm run build' for the current UI."
}

$hostScript = Join-Path $installDir "server\pty-host.js"
$webScript = Join-Path $installDir "server\server.js"
$hostPort = if ($env:PTY_HOST_PORT) { [int]$env:PTY_HOST_PORT } else { 8777 }

Write-WtHeader "PTY host"
$listening = Get-NetTCPConnection -State Listen -LocalPort $hostPort -ErrorAction SilentlyContinue
if ($listening) {
    Write-WtOk "already running on 127.0.0.1:$hostPort (existing sessions kept)"
} elseif ($Foreground) {
    Write-WtInfo "will start in this console"
} else {
    if (-not (Test-WtDeps -InstallDir $installDir -Node $node)) { exit 1 }
    if (Start-WtPtyHost -InstallDir $installDir -Node $node -Port $hostPort) {
        Write-WtOk "started detached"
    } else {
        exit 1
    }
}

Write-WtHeader "Web server"
if ($Foreground -and -not $listening) {
    Start-Process -FilePath $node -ArgumentList ('"' + $hostScript + '"') -WorkingDirectory $installDir -NoNewWindow
    Start-Sleep -Seconds 1
}
Write-WtInfo "Ctrl+C stops the web server only."
& $node $webScript
