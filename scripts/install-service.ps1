<#
.SYNOPSIS
  Registers the Web Terminal as two auto-starting Windows Scheduled Tasks.

.DESCRIPTION
  Task 1  WebTerminal-PtyHost   owns every ConPTY session (must start first)
  Task 2  WebTerminal-Web       serves HTTP/WebSocket (starts 20s later)

  Scheduled Tasks are used instead of a real Windows Service because Node needs
  no service wrapper here and tasks survive reboots, restart on failure and are
  managed with built-in tooling. NSSM works too - see docs/huong-dan-chi-tiet.md.

  Settings are read from MACHINE-level environment variables so both tasks
  inherit them. Pass -PasswordHash (preferred) or -Password to set them.

.EXAMPLE
  # Generate a hash first, then install:
  node scripts\hash-password.js "MyStrongPassword"
  .\scripts\install-service.ps1 -PasswordHash "scrypt$..." -Roots "C:\Users\you\projects;D:\work"

.EXAMPLE
  # Run the tasks as SYSTEM instead of the current user:
  .\scripts\install-service.ps1 -RunAsSystem
#>
[CmdletBinding()]
param(
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    [switch]$RunAsSystem,
    [string]$Password = "",
    [string]$PasswordHash = "",
    [string]$Roots = "",
    [int]$Port = 0,
    [int]$PtyHostPort = 0,
    [switch]$NoStart
)

. "$PSScriptRoot\common.ps1"
Assert-WtAdmin

$installDir = Get-WtInstallDir
$node = Get-WtNodePath
$hostScript = Join-Path $installDir "server\pty-host.js"
$webScript = Join-Path $installDir "server\server.js"

foreach ($p in @($hostScript, $webScript)) {
    if (-not (Test-Path $p)) { throw "Missing $p - run this from the installed copy." }
}
if (-not (Test-Path (Join-Path $installDir "dist\index.html"))) {
    Write-WtWarn "dist\index.html not found. Run 'npm run build' or the UI will fall back to public\."
}

Write-WtHeader "Machine environment"

function Set-MachineEnv {
    param([string]$Name, [string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    [Environment]::SetEnvironmentVariable($Name, $Value, "Machine")
    if ($Name -like "*PASSWORD*") { Write-WtOk "$Name set (value hidden)" }
    else { Write-WtOk "$Name = $Value" }
}

Set-MachineEnv "WEB_TERMINAL_PASSWORD_HASH" $PasswordHash
if ($Password -and -not $PasswordHash) {
    Set-MachineEnv "WEB_TERMINAL_PASSWORD" $Password
    Write-WtWarn "A plaintext password is stored in the registry. Prefer -PasswordHash."
}
Set-MachineEnv "WEB_TERMINAL_ROOTS" $Roots
if ($Port -gt 0) { Set-MachineEnv "PORT" "$Port" }
if ($PtyHostPort -gt 0) { Set-MachineEnv "PTY_HOST_PORT" "$PtyHostPort" }

$effectiveAuth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD_HASH", "Machine")
if (-not $effectiveAuth) { $effectiveAuth = [Environment]::GetEnvironmentVariable("WEB_TERMINAL_PASSWORD", "Machine") }
if (-not $effectiveAuth) {
    Write-WtWarn "No password configured. Anyone who can reach the port gets a shell."
}

Write-WtHeader "Scheduled tasks"

if ($RunAsSystem) {
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Write-WtWarn "Tasks will run as SYSTEM. Terminals get full machine rights and will NOT see the interactive user's profile (Claude Code config, npm cache, PATH additions)."
} else {
    # S4U needs no stored password and keeps the user profile, which is what
    # Claude Code and per-user tool installs expect.
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
    Write-WtInfo "Tasks will run as $User (S4U, no stored password)."
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

function Register-WtTask {
    param([string]$Name, [string]$Script, [timespan]$Delay)
    $action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $Script + '"') -WorkingDirectory $installDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = "PT$([int]$Delay.TotalSeconds)S"
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description "Web Terminal ($Name)" -Force | Out-Null
    Write-WtOk "registered $Name"
}

Register-WtTask -Name (Get-WtHostTaskName) -Script $hostScript -Delay (New-TimeSpan -Seconds 10)
Register-WtTask -Name (Get-WtWebTaskName) -Script $webScript -Delay (New-TimeSpan -Seconds 30)

if (-not $NoStart) {
    Write-WtHeader "Starting"
    Start-ScheduledTask -TaskName (Get-WtHostTaskName)
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName (Get-WtWebTaskName)
    Start-Sleep -Seconds 3
    & "$PSScriptRoot\status-service.ps1"
} else {
    Write-WtInfo "Installed without starting. Use scripts\start-service.ps1"
}

Write-Host ""
Write-WtInfo "After a reboot the PTY host starts first, then the web server."
Write-WtWarn "A reboot cannot preserve a running Claude Code process - Windows/ConPTY has no checkpoint/restore. Sessions survive browser and web-server restarts, not machine restarts."
