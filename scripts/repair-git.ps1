<#
.SYNOPSIS
  Remove the Windows folder-view files that Explorer leaves inside .git.

.DESCRIPTION
  Git reads every file under .git\refs as a ref. Windows writes desktop.ini
  into folders whose view has been customised - by Explorer, by OneDrive, by a
  redirected profile - and when it lands in refs\, git stops dead:

      fatal: bad object refs/desktop.ini
      error: ... did not send all necessary objects

  Every command that walks the refs fails, so a pull looks like a network or a
  server problem while nothing is wrong with either. This has now cost two
  sessions on machine 42 alone.

  The files are Explorer's, not the repository's: deleting them loses a folder
  icon and nothing else.

.EXAMPLE
  .\scripts\repair-git.ps1
  .\scripts\repair-git.ps1 -Path E:\somewhere\else\repo
#>
[CmdletBinding()]
param([string]$Path = "")

. "$PSScriptRoot\common.ps1"

if (-not $Path) { $Path = Split-Path -Parent $PSScriptRoot }
$git = Join-Path $Path ".git"

Write-WtHeader "Repairing $Path"

if (-not (Test-Path -LiteralPath $git)) {
    Write-WtFail "no .git here"
    exit 1
}

# -Force because desktop.ini is hidden and system; without it Get-ChildItem
# returns nothing and the repair reports success while the file is still there.
$cruft = @(Get-ChildItem -LiteralPath $git -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in 'desktop.ini', 'Thumbs.db' })

if (-not $cruft) {
    Write-WtOk "nothing to remove from .git"
} else {
    foreach ($f in $cruft) {
        try {
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
            Write-WtOk "removed $($f.FullName.Substring($Path.Length + 1))"
        } catch {
            Write-WtFail "could not remove $($f.FullName): $($_.Exception.Message)"
        }
    }
}

Write-WtHeader "Checking the repository"
Push-Location $Path
try {
    # A ref walk is exactly what desktop.ini breaks, so it is the honest test.
    $out = git for-each-ref --format='%(refname)' 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-WtOk "refs read cleanly ($(@($out).Count) refs)"
        Write-WtInfo "now: git pull"
    } else {
        Write-WtFail "git still unhappy:"
        $out | ForEach-Object { Write-Host "    $_" }
    }
} finally {
    Pop-Location
}
