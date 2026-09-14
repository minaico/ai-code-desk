<#
.SYNOPSIS
  Publishes the local Web Terminal through a Cloudflare Quick Tunnel (HTTPS + WSS).

.DESCRIPTION
  1. checks the web server answers on /health (starts it if asked)
  2. checks cloudflared is installed
  3. starts a Quick Tunnel
  4. prints the public https://<random>.trycloudflare.com URL

  A Quick Tunnel is unauthenticated at the edge: anyone with the URL reaches
  your login page. Only use it with a password set, and only for testing.
  For production use a named tunnel + Cloudflare Access (see README).

.EXAMPLE
  .\scripts\start-cloudflare-test.ps1
  .\scripts\start-cloudflare-test.ps1 -Port 8080 -StartServer
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$StartServer,
    [int]$TimeoutSec = 60
)

. "$PSScriptRoot\common.ps1"

if ($Port -le 0) { $Port = Get-WtPort }
$installDir = Get-WtInstallDir

Write-WtHeader "1/4 Web server"
$health = Get-WtHealth -Port $Port
if (-not $health -and $StartServer) {
    Write-WtInfo "not running - starting it"
    $node = Get-WtNodePath
    Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $installDir "server\server.js") + '"') `
        -WorkingDirectory $installDir -WindowStyle Hidden
    for ($i = 0; $i -lt 20 -and -not $health; $i++) {
        Start-Sleep -Seconds 1
        $health = Get-WtHealth -Port $Port
    }
}
if (-not $health) {
    Write-WtFail "http://127.0.0.1:$Port/health does not answer."
    Write-WtInfo "Start it first:  .\scripts\start.ps1     (or re-run with -StartServer)"
    exit 1
}
Write-WtOk "web server healthy on port $Port (PTY host connected: $($health.hostConnected))"

$auth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD_HASH", "Machine")
if (-not $auth) { $auth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD", "Machine") }
if (-not $auth) { $auth = $env:WEB_TERMINAL_PASSWORD }
if (-not $auth) {
    Write-WtFail "No password is configured. A public tunnel would expose an open shell."
    Write-WtInfo "Set one:  node scripts\hash-password.js   then restart the server."
    exit 1
}
Write-WtOk "authentication is enabled"

Write-WtHeader "2/4 cloudflared"
$cloudflared = $null
$cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cmd) {
    $cloudflared = $cmd.Source
} else {
    $candidates = @(
        "$env:ProgramFiles\cloudflared\cloudflared.exe",
        "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
        "$env:USERPROFILE\cloudflared\cloudflared.exe",
        (Join-Path $installDir "cloudflared.exe")
    )
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { $cloudflared = $p; break } }
}
if (-not $cloudflared) {
    Write-WtFail "cloudflared.exe not found."
    Write-WtInfo "Install:  winget install --id Cloudflare.cloudflared"
    exit 1
}
Write-WtOk "$cloudflared"

Write-WtHeader "3/4 Quick Tunnel"
$logFile = Join-Path $env:TEMP ("wt-cloudflared-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$proc = Start-Process -FilePath $cloudflared `
    -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port") `
    -RedirectStandardError $logFile -RedirectStandardOutput "$logFile.out" `
    -PassThru -WindowStyle Hidden
Write-WtInfo "cloudflared pid $($proc.Id), log $logFile"

Write-WtHeader "4/4 Public URL"
$publicUrl = $null
for ($i = 0; $i -lt $TimeoutSec -and -not $publicUrl; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) {
        Write-WtFail "cloudflared exited with code $($proc.ExitCode)"
        if (Test-Path $logFile) { Get-Content $logFile -Tail 20 }
        exit 1
    }
    foreach ($f in @($logFile, "$logFile.out")) {
        if (-not (Test-Path $f)) { continue }
        $m = Select-String -Path $f -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue |
             Select-Object -First 1
        if ($m) { $publicUrl = $m.Matches[0].Value; break }
    }
}

if (-not $publicUrl) {
    Write-WtFail "No tunnel URL after $TimeoutSec seconds."
    if (Test-Path $logFile) { Get-Content $logFile -Tail 30 }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ""
Write-Host "  $publicUrl" -ForegroundColor Green
Write-Host ""
Write-WtInfo "Open that URL on your phone. WebSocket runs over WSS through the same host."
Write-WtInfo "Stop the tunnel:  Stop-Process -Id $($proc.Id)"
Write-WtWarn "Quick Tunnels are public. Keep the password on, and shut the tunnel down when finished."

try {
    Write-WtInfo "Press Ctrl+C to stop the tunnel."
    Wait-Process -Id $proc.Id
} finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
