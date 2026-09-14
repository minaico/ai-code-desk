param(
  [string]$InstallDir = (Get-Location).Path,
  [string]$TaskName = "WindowsWebTerminal-PTYHost"
)
$ErrorActionPreference = "Stop"
$node = (Get-Command node -ErrorAction Stop).Source
$hostScript = Join-Path $InstallDir "server\pty-host.js"
if (!(Test-Path $hostScript)) { throw "pty-host.js not found: $hostScript" }
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $hostScript + '"') -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started: $TaskName"
Write-Host "PTY host will start automatically after Windows reboot."
