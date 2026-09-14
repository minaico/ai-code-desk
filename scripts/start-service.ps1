<#
.SYNOPSIS
  Starts the Web Terminal scheduled tasks in the correct order.
#>
[CmdletBinding()]
param()

. "$PSScriptRoot\common.ps1"

foreach ($name in @((Get-WtHostTaskName), (Get-WtWebTaskName))) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { throw "$name is not installed. Run scripts\install-service.ps1 first." }
}

Write-WtHeader "Starting Web Terminal"
Start-ScheduledTask -TaskName (Get-WtHostTaskName)
Write-WtOk "PTY host requested"
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName (Get-WtWebTaskName)
Write-WtOk "web server requested"
Start-Sleep -Seconds 3
& "$PSScriptRoot\status-service.ps1"
