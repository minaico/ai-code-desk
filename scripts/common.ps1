# Shared helpers for the Web Terminal management scripts.
# Dot-source this file:  . "$PSScriptRoot\common.ps1"

$ErrorActionPreference = "Stop"

$script:WtInstallDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script:WtHostTask = "WebTerminal-PtyHost"
$script:WtWebTask = "WebTerminal-Web"

function Get-WtInstallDir { $script:WtInstallDir }
function Get-WtHostTaskName { $script:WtHostTask }
function Get-WtWebTaskName { $script:WtWebTask }

function Get-WtNodePath {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    throw "node.exe not found. Install Node.js 18+ and make sure it is on PATH."
}

function Test-WtAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-WtAdmin {
    if (-not (Test-WtAdmin)) {
        throw "This script must run in an elevated PowerShell (Run as Administrator)."
    }
}

function Get-WtPort {
    $p = [Environment]::GetEnvironmentVariable("PORT", "Machine")
    if (-not $p) { $p = $env:PORT }
    if (-not $p) { $p = "8080" }
    return [int]$p
}

function Get-WtHealth {
    param([int]$Port = 0)
    if ($Port -le 0) { $Port = Get-WtPort }
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 4 -ErrorAction Stop
        return $r
    } catch {
        return $null
    }
}

function Write-WtHeader {
    param([string]$Text)
    Write-Host ""
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Write-WtOk    { param([string]$m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Write-WtWarn  { param([string]$m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Write-WtFail  { param([string]$m) Write-Host "  [fail] $m" -ForegroundColor Red }
function Write-WtInfo  { param([string]$m) Write-Host "  $m" }

# ---------------------------------------------------------------- PTY host

<#
.SYNOPSIS
  Check the things that make the PTY host die before it can log anything.
.DESCRIPTION
  server/pty-host.js does require("node-pty") at the top of the file, before it
  opens its log. So the one failure a freshly cloned machine actually hits -
  dependencies missing, or a native module built against another Node - leaves
  no log at all. Ask node itself, and report what it says.
#>
function Test-WtDeps {
    param([string]$InstallDir, [string]$Node)

    $version = (& $Node --version)
    Write-WtInfo "node $version  ($Node)"

    if (-not (Test-Path (Join-Path $InstallDir "node_modules"))) {
        Write-WtFail "node_modules is missing - dependencies were never installed here."
        Write-WtInfo "Fix:  npm ci --omit=dev     (or: npm install)"
        return $false
    }

    # node -e resolves require() against the current directory, so ask from
    # the install directory rather than from wherever the script was invoked.
    # Everything goes to stdout, so nothing depends on how PowerShell wraps stderr.
    Push-Location $InstallDir
    try {
        $probe = & $Node -e "try{require('node-pty');console.log('ok')}catch(e){console.log('ERR '+((e&&e.message)||e))}"
    } finally {
        Pop-Location
    }
    if ($probe -notmatch '^ok') {
        Write-WtFail "node-pty will not load:"
        Write-WtInfo "  $probe"
        Write-WtInfo "It is a native module, so it must match this machine's Node."
        Write-WtInfo "Fix:  npm rebuild node-pty        (or: rm -r node_modules; npm ci)"
        return $false
    }
    Write-WtOk "dependencies load (node-pty ok)"
    return $true
}

<#
.SYNOPSIS
  Start the PTY host detached and wait for it to actually listen.
.DESCRIPTION
  Captures stdout and stderr to <dataDir>/logs so a crash at startup is
  visible, and waits for the port instead of guessing a sleep: on a cold
  machine node-pty can take longer than the two seconds we used to allow.
.OUTPUTS
  $true when the port is listening.
#>
function Start-WtPtyHost {
    param(
        [string]$InstallDir,
        [string]$Node,
        [int]$Port,
        [int]$TimeoutSeconds = 20
    )

    # Never report success because *something* answers on the port. A host that
    # is already there belongs to someone else, and its sessions are somebody's
    # running work - saying "started" here invites killing the wrong process.
    $taken = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($taken) {
        $owner = Get-Process -Id $taken.OwningProcess -ErrorAction SilentlyContinue
        Write-WtFail "port $Port is already taken by pid $($taken.OwningProcess) ($($owner.ProcessName))."
        Write-WtInfo "That may be a PTY host with live sessions. Stop it deliberately, or pick another port."
        return $false
    }

    $logDir = Join-Path $InstallDir ".data\logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $outLog = Join-Path $logDir "pty-host.out.log"
    $errLog = Join-Path $logDir "pty-host.err.log"
    # WriteAllText, not Set-Content: no BOM to prepend to node's own output.
    foreach ($f in @($outLog, $errLog)) { [IO.File]::WriteAllText($f, "") }

    $proc = Start-Process -FilePath $Node `
        -ArgumentList ('"' + (Join-Path $InstallDir "server\pty-host.js") + '"') `
        -WorkingDirectory $InstallDir -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            Write-WtFail "the PTY host exited immediately (code $($proc.ExitCode))."
            Show-WtHostLogs -InstallDir $InstallDir
            return $false
        }
        $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $proc.Id } | Select-Object -First 1
        if ($listening) { return $true }
        Start-Sleep -Milliseconds 400
    }

    Write-WtFail "the PTY host did not start listening on $Port within ${TimeoutSeconds}s."
    Show-WtHostLogs -InstallDir $InstallDir
    return $false
}

<# Print whatever the PTY host managed to say before it died. #>
function Show-WtHostLogs {
    param([string]$InstallDir, [int]$Lines = 30)

    $logDir = Join-Path $InstallDir ".data\logs"
    $shown = $false
    foreach ($name in @("pty-host.err.log", "pty-host.out.log")) {
        $file = Join-Path $logDir $name
        if ((Test-Path $file) -and (Get-Item $file).Length -gt 0) {
            Write-Host ""
            Write-WtInfo "--- $name ---"
            Get-Content $file -Tail $Lines | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
            $shown = $true
        }
    }

    $daily = Get-ChildItem (Join-Path $logDir "pty-host-*.log") -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if ($daily) {
        Write-Host ""
        Write-WtInfo "--- $($daily.Name) ---"
        Get-Content $daily.FullName -Tail $Lines | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        $shown = $true
    }

    if (-not $shown) {
        Write-WtWarn "no output at all - node exited before it could log anything."
        Write-WtInfo "Run it in the foreground to see why:"
        Write-WtInfo "  node server\pty-host.js"
    }
}
