<#
.SYNOPSIS
  Installs dependencies, builds the UI and checks the machine is ready.
.EXAMPLE
  .\scripts\install.ps1
  .\scripts\install.ps1 -Password "MyStrongPassword" -Roots "C:\Users\you\projects;D:\work"
#>
[CmdletBinding()]
param(
    [string]$Password = "",
    [string]$Roots = "",
    [switch]$SkipInstall,
    [switch]$SkipBuild
)

. "$PSScriptRoot\common.ps1"
$installDir = Get-WtInstallDir
Push-Location $installDir
try {
    Write-WtHeader "Environment"
    $node = Get-WtNodePath
    $nodeVersion = (& $node --version).Trim()
    Write-WtOk "node $nodeVersion ($node)"
    if ([int]($nodeVersion -replace "^v(\d+).*", '$1') -lt 18) { throw "Node.js 18 or newer is required." }

    if (Get-Command git -ErrorAction SilentlyContinue) { Write-WtOk "git found" } else { Write-WtWarn "git not found - the Git panel will report errors." }
    if (Get-Command claude -ErrorAction SilentlyContinue) { Write-WtOk "claude found" } else { Write-WtWarn "claude not on PATH - set CLAUDE_BIN if you want the Claude launcher." }

    if (-not $SkipInstall) {
        Write-WtHeader "npm install"
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        Write-WtOk "dependencies installed"
    }

    if (-not $SkipBuild) {
        Write-WtHeader "npm run build"
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "build failed" }
        Write-WtOk "UI built into dist\"
    }

    Write-WtHeader "Configuration"
    if ($Password) {
        $hash = (& $node (Join-Path $installDir "scripts\hash-password.js") $Password).Trim()
        [Environment]::SetEnvironmentVariable("WEB_TERMINAL_PASSWORD_HASH", $hash, "Machine")
        Write-WtOk "WEB_TERMINAL_PASSWORD_HASH stored at machine level (plaintext never saved)"
    }
    if ($Roots) {
        [Environment]::SetEnvironmentVariable("WEB_TERMINAL_ROOTS", $Roots, "Machine")
        Write-WtOk "WEB_TERMINAL_ROOTS = $Roots"
    }

    $hasAuth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD_HASH", "Machine")
    if (-not $hasAuth) { $hasAuth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD", "Machine") }
    if (-not $hasAuth) { $hasAuth = $env:WEB_TERMINAL_PASSWORD }
    if ($hasAuth) { Write-WtOk "authentication configured" } else { Write-WtWarn "NO PASSWORD SET - do not expose this beyond localhost" }

    Write-Host ""
    Write-WtInfo "Next steps:"
    Write-WtInfo "  run once now      : .\scripts\start.ps1"
    Write-WtInfo "  install autostart : .\scripts\install-service.ps1   (elevated)"
    Write-WtInfo "  public test URL   : .\scripts\start-cloudflare-test.ps1"
} finally {
    Pop-Location
}
