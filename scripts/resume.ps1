<#
.SYNOPSIS
  Bring the Web Terminal back up after a shutdown, a power cut or a crash.

.DESCRIPTION
  Safe to run at any time, as often as you like. It starts only what is not
  already listening, so running it while the PTY host is alive does not cost
  you a single terminal.

  This is the manual counterpart to install-service.ps1. That one needs admin
  and starts the app at boot; this one needs neither admin nor a reboot, and is
  what you run when the machine came back and the app did not.

  Unlike start.ps1, nothing here runs in your console. Both processes are
  launched detached, so closing this window leaves them running.

.PARAMETER Restart
  Stop whatever is listening on the two ports first, then start clean. This
  kills every running terminal - only use it when you mean to.

.PARAMETER OpenBrowser
  Open the web UI once the server answers.

.PARAMETER Port
  Web server port for this run. Overrides the persisted PORT.

.PARAMETER PtyHostPort
  PTY host port for this run. Overrides the persisted PTY_HOST_PORT.

.PARAMETER LocalOnly
  Keep the PTY host on 127.0.0.1 even though other machines are in the group.
  By default it listens on the LAN whenever .data\hosts.json lists another
  machine: every machine in a group has to be reachable by whichever one is
  main, and that is about to be a different one when the config is moved.

.EXAMPLE
  .\scripts\resume.ps1

.EXAMPLE
  # After changing code: stop everything, then come back up on the new build.
  .\scripts\resume.ps1 -Restart
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$OpenBrowser,
    [int]$Port = 0,
    [int]$PtyHostPort = 0,
    [switch]$LocalOnly
)

. "$PSScriptRoot\common.ps1"

$installDir = Get-WtInstallDir
$node = Get-WtNodePath

<#
Read a setting the way the processes this script starts will read it.

Win32_Process.Create builds the child's environment from the registry - Machine
first, then User on top - and ignores the variables of the shell that called it.
So `$env:PORT = 9090` before running this script changes nothing for the server,
and using it here would leave the script waiting on one port while the server
binds another. Ports asked for on the command line are passed to the child
explicitly instead; see Start-WtDetached.
#>
function Get-WtPersistedEnv {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, "User")
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [Environment]::GetEnvironmentVariable($Name, "Machine")
    }
    return $value
}

function Resolve-WtPort {
    param([int]$Override, [string]$Name, [int]$Default)
    if ($Override -gt 0) { return $Override }
    $persisted = Get-WtPersistedEnv -Name $Name
    if ($persisted -and ($persisted -as [int])) { return [int]$persisted }
    return $Default
}

$webPort = Resolve-WtPort -Override $Port -Name "PORT" -Default 8080
$hostPort = Resolve-WtPort -Override $PtyHostPort -Name "PTY_HOST_PORT" -Default 8777

# Only the values that differ from what the child would read on its own need
# passing through; everything else already reaches it from the registry.
$hostEnv = @{}
$webEnv = @{}
if ($PtyHostPort -gt 0) {
    $hostEnv["PTY_HOST_PORT"] = $PtyHostPort
    $webEnv["PTY_HOST_PORT"] = $PtyHostPort
}
if ($Port -gt 0) { $webEnv["PORT"] = $Port }

<#
Other machines in the group are the entries that do not hold this machine's own
key - each machine generates its own, so that is the one entry that is us. It
also works before the web server has ever added this machine to the list.
#>
function Get-WtOtherMachines {
    $file = Join-Path $installDir ".data\hosts.json"
    $keyFile = Join-Path $installDir ".data\host.key"
    if (-not (Test-Path $file)) { return @() }
    $ownKey = if (Test-Path $keyFile) { (Get-Content $keyFile -Raw).Trim() } else { "" }
    try {
        return @(Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json | Where-Object { $_.key -ne $ownKey })
    } catch {
        Write-WtWarn "hosts.json could not be read: $($_.Exception.Message)"
        return @()
    }
}

$others = Get-WtOtherMachines
$persistedBind = Get-WtPersistedEnv -Name "PTY_HOST_BIND"
$lanWanted = $others.Count -gt 0 -and -not $LocalOnly
if ($lanWanted -and -not $persistedBind) { $hostEnv["PTY_HOST_BIND"] = "0.0.0.0" }

$logDir = Join-Path $installDir ".data\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd"
$hostLog = Join-Path $logDir "resume-pty-host-$stamp.log"
$webLog = Join-Path $logDir "resume-web-$stamp.log"

function Get-WtListener {
    param([int]$Port)
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
}

<#
Launch a Node script that outlives this console.

Start-Process would make the child a member of this console's process tree, and
closing the window takes the whole tree with it - the PTY host and every
terminal inside it. That is the exact accident this script exists to undo, so
it must not be able to cause it. Win32_Process.Create starts a process that
belongs to nobody here.

The cmd.exe wrapper is only there to append stdout and stderr to a log. Without
it a host that dies on startup leaves nothing to read, which is how a five
minute problem becomes an afternoon.
#>
function Start-WtDetached {
    param([string]$ScriptPath, [string]$LogFile, [hashtable]$EnvOverrides = @{})

    $prefix = ""
    foreach ($name in $EnvOverrides.Keys) {
        $prefix += 'set "{0}={1}" && ' -f $name, $EnvOverrides[$name]
    }

    $startup = ([WMICLASS]"Win32_ProcessStartup").CreateInstance()
    $startup.ShowWindow = 0  # SW_HIDE
    $line = 'cmd.exe /c "{0}"{1}" "{2}" >> "{3}" 2>&1"' -f $prefix, $node, $ScriptPath, $LogFile
    $result = ([WMICLASS]"Win32_Process").Create($line, $installDir, $startup)
    if ($result.ReturnValue -ne 0) {
        Write-WtFail "could not launch the process (Win32_Process.Create returned $($result.ReturnValue))."
        return $false
    }
    return $true
}

function Wait-WtListening {
    param([int]$Port, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $conn = Get-WtListener -Port $Port
        if ($conn) { return $conn }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Show-WtTail {
    param([string]$File, [int]$Lines = 20)
    if ((Test-Path $File) -and (Get-Item $File).Length -gt 0) {
        Write-WtInfo "--- $(Split-Path $File -Leaf) ---"
        Get-Content $File -Tail $Lines | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
    } else {
        Write-WtWarn "no output at all - node exited before it could log anything."
    }
}

# ---------------------------------------------------------------------------

Write-WtHeader "Web Terminal - resume"
Write-WtInfo "folder    $installDir"
Write-WtInfo "ports     PTY host $hostPort, web $webPort"

if ($Restart) {
    Write-WtHeader "Stopping first (-Restart)"
    Write-WtWarn "every running terminal on this machine is about to be closed."
    # stop-service.ps1 finds the host by port, so tell it which one we mean.
    $env:PTY_HOST_PORT = "$hostPort"
    $env:PORT = "$webPort"
    & (Join-Path $PSScriptRoot "stop-service.ps1")
    Start-Sleep -Seconds 2
}

Write-WtHeader "Dependencies"
if (-not (Test-WtDeps -InstallDir $installDir -Node $node)) { exit 1 }
if (-not (Test-Path (Join-Path $installDir "dist\index.html"))) {
    Write-WtWarn "dist\index.html is missing - the UI will be stale or absent. Run: npm run build"
}

Write-WtHeader "PTY host"
$hostConn = Get-WtListener -Port $hostPort
if ($hostConn) {
    # Never assume the thing on the port is ours to keep or to kill. If it is a
    # PTY host, those are somebody's running terminals; if it is not, starting a
    # second one on the same port would only fail in a more confusing way.
    $owner = Get-Process -Id $hostConn.OwningProcess -ErrorAction SilentlyContinue
    Write-WtOk "already listening on $($hostConn.LocalAddress) (pid $($hostConn.OwningProcess), $($owner.ProcessName)) - sessions kept"
    if ($lanWanted -and $hostConn.LocalAddress -eq "127.0.0.1") {
        Write-WtWarn "it only listens on localhost, so the other machines in the group cannot reach this one."
        Write-WtInfo "  -Restart brings it up on the LAN (and closes every terminal here)."
    }
} else {
    if (-not (Start-WtDetached -ScriptPath (Join-Path $installDir "server\pty-host.js") -LogFile $hostLog -EnvOverrides $hostEnv)) { exit 1 }
    $hostConn = Wait-WtListening -Port $hostPort
    if ($hostConn) {
        Write-WtOk "started on $($hostConn.LocalAddress), pid $($hostConn.OwningProcess)"
    } else {
        Write-WtFail "the PTY host did not start listening on $hostPort."
        Show-WtTail -File $hostLog
        exit 1
    }
}

if ($lanWanted) {
    # Scoped to the machines in the group rather than "LocalSubnet": they are
    # often on different subnets behind one router (192.168.191.x talking to
    # 192.168.192.x), where a subnet rule lets in nobody who matters.
    $ruleName = "Web Terminal PTY host $hostPort"
    $peers = ($others | ForEach-Object { $_.address } | Where-Object { $_ } | Sort-Object -Unique) -join ","
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        Write-WtOk "firewall rule present: $ruleName"
    } else {
        Write-WtWarn "no firewall rule for TCP $hostPort - the other machines may be blocked. In an elevated PowerShell:"
        Write-WtInfo "  New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $hostPort -RemoteAddress $peers"
    }
}

Write-WtHeader "Web server"
$webConn = Get-WtListener -Port $webPort
if ($webConn) {
    Write-WtOk "already listening (pid $($webConn.OwningProcess))"
} else {
    if (-not (Start-WtDetached -ScriptPath (Join-Path $installDir "server\server.js") -LogFile $webLog -EnvOverrides $webEnv)) { exit 1 }
    $webConn = Wait-WtListening -Port $webPort
    if ($webConn) {
        Write-WtOk "started, pid $($webConn.OwningProcess)"
    } else {
        Write-WtFail "the web server did not start listening on $webPort."
        Show-WtTail -File $webLog
        exit 1
    }
}

Write-WtHeader "Health"
$health = $null
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    $health = Get-WtHealth -Port $webPort
    if ($health) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $health) {
    Write-WtFail "the port is open but /health does not answer."
    Show-WtTail -File $webLog
    exit 1
}
Write-WtOk "ok=$($health.ok)  ptyHost=$($health.hostConnected)  machines=$($health.machines)  sessions=$($health.sessions)"
if (-not $health.hostConnected) {
    Write-WtWarn "the web server cannot reach the PTY host - check .data\host.key and the port above."
}

# A restored machine has no terminals, and the tab strip being empty is what
# makes an intact workspace look like a lost one. Say out loud that the tabs are
# on disk and one click away, because the panel that restores them is not one
# anybody opens unprompted.
Write-WtHeader "Saved tabs"
$wsFile = Join-Path $installDir ".data\workspaces.json"
if (Test-Path $wsFile) {
    try {
        $ws = Get-Content $wsFile -Raw | ConvertFrom-Json
        $total = 0
        foreach ($prop in $ws.PSObject.Properties) {
            $tabs = $prop.Value.tabs
            if ($null -eq $tabs) { $tabs = $prop.Value }
            $n = @($tabs).Count
            $total += $n
            Write-WtInfo "$($prop.Name): $n tab(s), saved $($prop.Value.savedAt)"
        }
        if ($total -gt 0 -and $health.sessions -eq 0) {
            Write-WtOk "$total tab(s) waiting - open the panel and click the workspace button to reopen them."
        }
    } catch {
        Write-WtWarn "workspaces.json could not be read: $($_.Exception.Message)"
    }
} else {
    Write-WtInfo "no workspace saved yet."
}

Write-WtHeader "Ready"
$url = "http://localhost:$webPort"
Write-WtInfo $url
Write-WtInfo "Logs:  $hostLog"
Write-WtInfo "       $webLog"
Write-WtInfo "This window is safe to close - both processes are detached."
if ($OpenBrowser) { Start-Process $url }
