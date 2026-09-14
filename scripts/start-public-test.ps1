param(
    [int]$Port = 8080,
    [string]$ProjectDir = $PSScriptRoot,
    [switch]$NoPassword
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " Web Terminal + Cloudflare Quick Tunnel" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Find cloudflared
$cloudflared = $null
$cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cmd) {
    $cloudflared = $cmd.Source
} else {
    $candidates = @(
        "$env:ProgramFiles\cloudflared\cloudflared.exe",
        "$env:ProgramFiles\cloudflared\cloudflared-windows-amd64.exe",
        "$env:USERPROFILE\cloudflared\cloudflared.exe",
        "$PSScriptRoot\cloudflared.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) {
            $cloudflared = $p
            break
        }
    }
}

if (-not $cloudflared) {
    Write-Host "KHONG TIM THAY cloudflared.exe." -ForegroundColor Red
    Write-Host "Kiem tra: cloudflared --version"
    exit 1
}

Write-Host "cloudflared: $cloudflared" -ForegroundColor Green

# Check Node/npm
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "KHONG TIM THAY npm." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $ProjectDir "package.json"))) {
    Write-Host "Khong tim thay package.json trong: $ProjectDir" -ForegroundColor Red
    exit 1
}

# Quick Tunnel does not work when a cloudflared config.yaml is present
# in the default .cloudflared directory. Warn instead of silently modifying it.
$configCandidates = @(
    "$env:USERPROFILE\.cloudflared\config.yml",
    "$env:USERPROFILE\.cloudflared\config.yaml"
)
$configFound = $configCandidates | Where-Object { Test-Path $_ }

if ($configFound) {
    Write-Host ""
    Write-Host "CANH BAO: Phat hien Cloudflare config:" -ForegroundColor Yellow
    $configFound | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    Write-Host "Quick Tunnel co the khong chay khi config nay ton tai." -ForegroundColor Yellow
    Write-Host "Neu cloudflared bao loi, doi ten config tam thoi roi chay lai." -ForegroundColor Yellow
    Write-Host ""
}

# Check web terminal health before exposing it.
Write-Host "Kiem tra Web Terminal tai http://127.0.0.1:$Port ..." -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
    if (-not $health.ok) {
        throw "Health endpoint returned ok=false"
    }
    Write-Host "Web Terminal dang chay." -ForegroundColor Green
} catch {
    Write-Host "Web Terminal chua chay. Dang khoi dong..." -ForegroundColor Yellow

    $serverArgs = @(
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Set-Location -LiteralPath '$ProjectDir'; npm start"
    )

    $serverProcess = Start-Process powershell.exe `
        -ArgumentList $serverArgs `
        -WorkingDirectory $ProjectDir `
        -PassThru

    $ready = $false
    for ($i=0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.ok) {
                $ready = $true
                break
            }
        } catch {}
    }

    if (-not $ready) {
        Write-Host "Web Terminal khong khoi dong duoc." -ForegroundColor Red
        if ($serverProcess -and -not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        }
        exit 1
    }

    Write-Host "Web Terminal da san sang." -ForegroundColor Green
}

Write-Host ""
Write-Host "Dang tao Cloudflare Quick Tunnel..." -ForegroundColor Cyan
Write-Host "URL se co dang: https://xxxxx.trycloudflare.com" -ForegroundColor DarkGray
Write-Host ""

# Optional: warn if no password is configured.
$oldPassword = $env:WEB_TERMINAL_PASSWORD
if (-not $NoPassword -and [string]::IsNullOrWhiteSpace($env:WEB_TERMINAL_PASSWORD)) {
    Write-Host "CANH BAO: WEB_TERMINAL_PASSWORD dang rong." -ForegroundColor Red
    Write-Host "Web Terminal cho phep chay lenh Windows, khong nen expose public ma khong co password." -ForegroundColor Red
    $answer = Read-Host "Ban van muon tiep tuc test? (YES/NO)"
    if ($answer -ne "YES") {
        Write-Host "Da huy."
        exit 0
    }
}

Write-Host "=============================================" -ForegroundColor Green
Write-Host " PUBLIC URL: xem dong cloudflared ben duoi" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""

try {
    & $cloudflared tunnel --url "http://127.0.0.1:$Port"
}
finally {
    Write-Host ""
    Write-Host "Cloudflare Tunnel da dung." -ForegroundColor Yellow
}
