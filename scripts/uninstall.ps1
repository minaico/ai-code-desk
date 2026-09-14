<#
.SYNOPSIS
  Removes the autostart tasks, stops the processes and optionally deletes local state.
.PARAMETER PurgeData
  Also delete .data\ (auth secret, logs). Every browser will have to log in again.
.PARAMETER PurgeModules
  Also delete node_modules\ and dist\.
#>
[CmdletBinding()]
param(
    [switch]$PurgeData,
    [switch]$PurgeModules
)

. "$PSScriptRoot\common.ps1"
$installDir = Get-WtInstallDir

if (Test-WtAdmin) {
    & "$PSScriptRoot\uninstall-service.ps1"
} else {
    Write-WtWarn "Not elevated - skipping scheduled task removal. Re-run as Administrator to remove autostart."
}

& "$PSScriptRoot\stop.ps1"

if ($PurgeData) {
    $data = Join-Path $installDir ".data"
    if (Test-Path $data) {
        Remove-Item $data -Recurse -Force
        Write-WtOk "removed .data (secret key and logs)"
    }
}

if ($PurgeModules) {
    foreach ($d in @("node_modules", "dist")) {
        $p = Join-Path $installDir $d
        if (Test-Path $p) {
            Remove-Item $p -Recurse -Force
            Write-WtOk "removed $d"
        }
    }
}

Write-Host ""
Write-WtInfo "Source files were left in place: $installDir"
